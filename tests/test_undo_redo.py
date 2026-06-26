"""Tests for the backend undo / redo log.

These tests exercise the actual HTTP endpoints so that undo recording (which
lives in the routers) is covered end-to-end.
"""
import pytest

from app.db.schema.constants import SYSTEM_CLASS_UUIDS

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def _create_page(client, page_class_uuid: str, name: str, extra_classes: list[str] | None = None):
    payload: dict = {
        "name": name,
        "class_uuids": [page_class_uuid] + (extra_classes or []),
    }
    r = await client.post("/api/nodes/", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


async def _get_node(client, node):
    r = await client.get(f"/api/nodes/{node['uuid']}")
    assert r.status_code == 200, r.text
    return r.json()


async def _class_class_uuid(client) -> str:
    r = await client.get("/api/nodes/classes")
    assert r.status_code == 200, r.text
    for node in r.json()["nodes"]:
        if node["uuid"] == SYSTEM_CLASS_UUIDS["class"]:
            return node["uuid"]
    raise RuntimeError("class class not found")


async def test_undo_redo_create_node(authenticated_client, test_user):
    page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
    page = await _create_page(authenticated_client, page_class_uuid, "Undo Create")

    stack = await authenticated_client.get("/api/undo/stack")
    assert stack.status_code == 200
    assert stack.json()["undo_count"] == 1

    undo = await authenticated_client.post("/api/undo/undo")
    assert undo.status_code == 200
    assert "Created" in undo.json()["description"]

    # Undo create => soft delete => GET returns 404
    get_after_undo = await authenticated_client.get(f"/api/nodes/{page['uuid']}")
    assert get_after_undo.status_code == 404

    redo = await authenticated_client.post("/api/undo/redo")
    assert redo.status_code == 200

    get_after_redo = await authenticated_client.get(f"/api/nodes/{page['uuid']}")
    assert get_after_redo.status_code == 200


async def test_undo_redo_update_node(authenticated_client, test_user):
    page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
    page = await _create_page(authenticated_client, page_class_uuid, "Before")

    r = await authenticated_client.put(f"/api/nodes/{page['uuid']}", json={"name": "After"})
    assert r.status_code == 200, r.text

    undo = await authenticated_client.post("/api/undo/undo")
    assert undo.status_code == 200

    page_after_undo = await _get_node(authenticated_client, page)
    assert "Before" in page_after_undo["name"]

    redo = await authenticated_client.post("/api/undo/redo")
    assert redo.status_code == 200

    page_after_redo = await _get_node(authenticated_client, page)
    assert "After" in page_after_redo["name"]


async def test_undo_redo_move_node(authenticated_client, test_user):
    page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
    parent_a = await _create_page(authenticated_client, page_class_uuid, "Parent A")
    parent_b = await _create_page(authenticated_client, page_class_uuid, "Parent B")

    block = await authenticated_client.post(
        "/api/nodes/",
        json={"name": "Block to move", "parent_uuid": parent_a["uuid"], "classes": []},
    )
    assert block.status_code == 200, block.text
    block_json = block.json()

    move = await authenticated_client.put(
        f"/api/nodes/{block_json['uuid']}/move",
        json={"parent_uuid": parent_b["uuid"]},
    )
    assert move.status_code == 200, move.text

    await authenticated_client.post("/api/undo/undo")
    block_after_undo = await _get_node(authenticated_client, block_json)
    assert block_after_undo["parent_id"] == parent_a["id"]

    await authenticated_client.post("/api/undo/redo")
    block_after_redo = await _get_node(authenticated_client, block_json)
    assert block_after_redo["parent_id"] == parent_b["id"]


async def test_undo_redo_tag_link(authenticated_client, test_user):
    page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
    source = await _create_page(authenticated_client, page_class_uuid, "Source")
    tag = await _create_page(authenticated_client, page_class_uuid, "Tag Page")

    add = await authenticated_client.post(
        f"/api/nodes/{source['uuid']}/tag-links",
        json={"target_node_uuid": tag["uuid"]},
    )
    assert add.status_code == 200, add.text

    source_after_add = await _get_node(authenticated_client, source)
    assert tag["id"] in source_after_add["tags"]

    await authenticated_client.post("/api/undo/undo")
    source_after_undo = await _get_node(authenticated_client, source)
    assert tag["id"] not in source_after_undo["tags"]

    await authenticated_client.post("/api/undo/redo")
    source_after_redo = await _get_node(authenticated_client, source)
    assert tag["id"] in source_after_redo["tags"]


async def test_undo_redo_alias(authenticated_client, test_user):
    page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
    source = await _create_page(authenticated_client, page_class_uuid, "Source")
    alias = await _create_page(authenticated_client, page_class_uuid, "Alias Page")

    add = await authenticated_client.post(
        f"/api/nodes/{source['uuid']}/aliases",
        json={"alias_node_uuid": alias["uuid"]},
    )
    assert add.status_code == 200, add.text

    source_after_add = await _get_node(authenticated_client, source)
    alias_after_add = await _get_node(authenticated_client, alias)
    assert alias["id"] in source_after_add["aliases"]
    assert alias_after_add["aliased_id"] == source["id"]

    await authenticated_client.post("/api/undo/undo")
    source_after_undo = await _get_node(authenticated_client, source)
    alias_after_undo = await _get_node(authenticated_client, alias)
    assert alias["id"] not in source_after_undo["aliases"]
    assert alias_after_undo["aliased_id"] is None

    await authenticated_client.post("/api/undo/redo")
    source_after_redo = await _get_node(authenticated_client, source)
    alias_after_redo = await _get_node(authenticated_client, alias)
    assert alias["id"] in source_after_redo["aliases"]
    assert alias_after_redo["aliased_id"] == source["id"]


async def test_undo_redo_add_remove_class(authenticated_client, test_user):
    page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
    class_class_uuid = await _class_class_uuid(authenticated_client)

    custom_class = await _create_page(
        authenticated_client, page_class_uuid, "Custom Class", extra_classes=[class_class_uuid]
    )
    page = await _create_page(authenticated_client, page_class_uuid, "Classed Page")

    # Add class
    add = await authenticated_client.post(
        f"/api/nodes/{page['uuid']}/classes",
        json={"class_node_uuid": custom_class["uuid"]},
    )
    assert add.status_code == 200, add.text

    page_after_add = await _get_node(authenticated_client, page)
    assert custom_class["id"] in page_after_add["classes"]

    # Undo add
    await authenticated_client.post("/api/undo/undo")
    page_after_undo_add = await _get_node(authenticated_client, page)
    assert custom_class["id"] not in page_after_undo_add["classes"]

    # Redo add
    await authenticated_client.post("/api/undo/redo")
    page_after_redo_add = await _get_node(authenticated_client, page)
    assert custom_class["id"] in page_after_redo_add["classes"]

    # Remove class
    remove = await authenticated_client.delete(
        f"/api/nodes/{page['uuid']}/classes/{custom_class['uuid']}"
    )
    assert remove.status_code == 200, remove.text

    page_after_remove = await _get_node(authenticated_client, page)
    assert custom_class["id"] not in page_after_remove["classes"]

    # Undo remove
    await authenticated_client.post("/api/undo/undo")
    page_after_undo_remove = await _get_node(authenticated_client, page)
    assert custom_class["id"] in page_after_undo_remove["classes"]

    # Redo remove
    await authenticated_client.post("/api/undo/redo")
    page_after_redo_remove = await _get_node(authenticated_client, page)
    assert custom_class["id"] not in page_after_redo_remove["classes"]
