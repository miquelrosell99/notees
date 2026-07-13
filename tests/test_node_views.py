"""Integration tests for NodeView per-view presentation persistence and management.

Covers the node_view columns added for per-view state (view_mode, sort_entries,
settings, JSONB group_by), the duplicate endpoint, set-default semantics,
reorder, and delete-last-view protection.
"""

import pytest
from httpx import AsyncClient


async def _create_page(auth_client: AsyncClient, name: str) -> str:
    resp = await auth_client.post("/api/nodes/", json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["uuid"]


async def _ensure_views(auth_client: AsyncClient, node_uuid: str, view_type: str = "child_pages") -> list[dict]:
    resp = await auth_client.post(
        f"/api/nodes/views/ensure-defaults/{node_uuid}",
        params={"view_types": [view_type]},
    )
    assert resp.status_code == 200, resp.text
    resp = await auth_client.get(
        "/api/nodes/views", params={"node_uuid": node_uuid, "view_type": view_type}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["views"]


@pytest.mark.asyncio
async def test_node_view_presentation_columns_exist(db_pool):
    """Migration adds per-view presentation columns; group_by is JSONB."""
    rows = await db_pool.fetch(
        """
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'node_view'
          AND column_name IN ('view_mode', 'sort_entries', 'settings', 'group_by')
        """
    )
    cols = {r["column_name"]: r["data_type"] for r in rows}
    assert cols.get("view_mode") == "text"
    assert cols.get("sort_entries") == "jsonb"
    assert cols.get("settings") == "jsonb"
    assert cols.get("group_by") == "jsonb"


@pytest.mark.asyncio
async def test_view_presentation_update_roundtrip(auth_client: AsyncClient):
    """PUT persists view_mode/sort_entries/settings/group_by; GET returns them."""
    node_uuid = await _create_page(auth_client, "Views Roundtrip Page")
    views = await _ensure_views(auth_client, node_uuid)
    assert len(views) == 1
    view = views[0]

    payload = {
        "view_mode": "kanban",
        "sort_entries": [
            {"key": "name", "direction": "asc"},
            {"key": "write_date", "direction": "desc"},
        ],
        "group_by": ["page", "9c6b8f5e-1f6a-4b5d-9f3e-111111111111"],
        "settings": {"cardLayout": "cover-top", "ganttTimeScale": "month"},
    }
    resp = await auth_client.put(f"/api/nodes/views/{view['uuid']}", json=payload)
    assert resp.status_code == 200, resp.text
    updated = resp.json()
    assert updated["view_mode"] == "kanban"
    assert updated["sort_entries"] == payload["sort_entries"]
    assert updated["group_by"] == payload["group_by"]
    assert updated["settings"] == payload["settings"]

    # Re-fetch to prove it round-trips through the DB, not just the response
    resp = await auth_client.get(f"/api/nodes/views/{view['uuid']}")
    assert resp.status_code == 200, resp.text
    fetched = resp.json()
    assert fetched["view_mode"] == "kanban"
    assert fetched["sort_entries"] == payload["sort_entries"]
    assert fetched["group_by"] == payload["group_by"]
    assert fetched["settings"] == payload["settings"]


@pytest.mark.asyncio
async def test_partial_update_leaves_presentation_untouched(auth_client: AsyncClient):
    """A PUT with only name must not clobber persisted presentation fields."""
    node_uuid = await _create_page(auth_client, "Views Partial Update Page")
    views = await _ensure_views(auth_client, node_uuid)
    view = views[0]

    resp = await auth_client.put(
        f"/api/nodes/views/{view['uuid']}",
        json={"view_mode": "table", "sort_entries": [{"key": "name", "direction": "asc"}]},
    )
    assert resp.status_code == 200, resp.text

    resp = await auth_client.put(f"/api/nodes/views/{view['uuid']}", json={"name": "Renamed"})
    assert resp.status_code == 200, resp.text
    renamed = resp.json()
    assert renamed["name"] == "Renamed"
    assert renamed["view_mode"] == "table"
    assert renamed["sort_entries"] == [{"key": "name", "direction": "asc"}]


@pytest.mark.asyncio
async def test_duplicate_view_copies_full_config(auth_client: AsyncClient):
    """POST /duplicate copies query + presentation config, is not default, appends order."""
    node_uuid = await _create_page(auth_client, "Views Duplicate Page")
    views = await _ensure_views(auth_client, node_uuid)
    source = views[0]

    resp = await auth_client.put(
        f"/api/nodes/views/{source['uuid']}",
        json={
            "view_mode": "gantt",
            "group_by": "page",
            "sort_entries": [{"key": "create_date", "direction": "desc"}],
            "settings": {"ganttTimeScale": "week"},
        },
    )
    assert resp.status_code == 200, resp.text

    resp = await auth_client.post(f"/api/nodes/views/{source['uuid']}/duplicate")
    assert resp.status_code == 200, resp.text
    copy = resp.json()

    assert copy["uuid"] != source["uuid"]
    assert copy["name"] == f"{source['name']} copy"
    assert copy["is_default"] is False
    assert copy["view_mode"] == "gantt"
    assert copy["group_by"] == "page"
    assert copy["sort_entries"] == [{"key": "create_date", "direction": "desc"}]
    assert copy["settings"] == {"ganttTimeScale": "week"}
    assert copy["query_ast"] is not None

    # Appended at the end of the tab order
    views = await _ensure_views(auth_client, node_uuid)
    assert [v["uuid"] for v in views] == [source["uuid"], copy["uuid"]]


@pytest.mark.asyncio
async def test_set_default_unsets_previous(auth_client: AsyncClient):
    """PUT {is_default: true} atomically unsets the previous default."""
    node_uuid = await _create_page(auth_client, "Views Default Page")
    views = await _ensure_views(auth_client, node_uuid)
    first = views[0]
    assert first["is_default"] is True

    resp = await auth_client.post(
        "/api/nodes/views",
        json={
            "node_uuid": node_uuid,
            "name": "Second",
            "view_type": "child_pages",
            "order_index": 1,
        },
    )
    assert resp.status_code == 200, resp.text
    second = resp.json()
    assert second["is_default"] is False

    resp = await auth_client.put(f"/api/nodes/views/{second['uuid']}", json={"is_default": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_default"] is True

    views = await _ensure_views(auth_client, node_uuid)
    by_uuid = {v["uuid"]: v for v in views}
    assert by_uuid[second["uuid"]]["is_default"] is True
    assert by_uuid[first["uuid"]]["is_default"] is False


@pytest.mark.asyncio
async def test_reorder_views(auth_client: AsyncClient):
    """POST /reorder persists the given tab order."""
    node_uuid = await _create_page(auth_client, "Views Reorder Page")
    views = await _ensure_views(auth_client, node_uuid)
    first = views[0]

    created = []
    for i, name in enumerate(("B", "C")):
        resp = await auth_client.post(
            "/api/nodes/views",
            json={
                "node_uuid": node_uuid,
                "name": name,
                "view_type": "child_pages",
                "order_index": i + 1,
            },
        )
        assert resp.status_code == 200, resp.text
        created.append(resp.json())

    new_order = [created[1]["uuid"], first["uuid"], created[0]["uuid"]]
    resp = await auth_client.post(
        f"/api/nodes/views/reorder/{node_uuid}/child_pages",
        json={"view_uuids": new_order},
    )
    assert resp.status_code == 200, resp.text

    views = await _ensure_views(auth_client, node_uuid)
    assert [v["uuid"] for v in views] == new_order
    assert [v["order_index"] for v in views] == [0, 1, 2]


@pytest.mark.asyncio
async def test_delete_last_view_rejected(auth_client: AsyncClient):
    """Deleting the only view of a view_type is refused."""
    node_uuid = await _create_page(auth_client, "Views Delete Page")
    views = await _ensure_views(auth_client, node_uuid)
    only = views[0]

    resp = await auth_client.delete(f"/api/nodes/views/{only['uuid']}")
    assert resp.status_code == 400, resp.text

    # With a second view present, deleting a non-default view works
    resp = await auth_client.post(
        "/api/nodes/views",
        json={
            "node_uuid": node_uuid,
            "name": "Disposable",
            "view_type": "child_pages",
            "order_index": 1,
        },
    )
    assert resp.status_code == 200, resp.text
    disposable = resp.json()

    resp = await auth_client.delete(f"/api/nodes/views/{disposable['uuid']}")
    assert resp.status_code == 200, resp.text
