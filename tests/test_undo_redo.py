"""Tests for the backend undo / redo log.

These tests exercise the actual HTTP endpoints so that undo recording (which
lives in the routers) is covered end-to-end.
"""
import pytest

from app.db.schema.constants import SYSTEM_CLASS_UUIDS

pytestmark = pytest.mark.asyncio


async def _create_page(client, page_class_id: int, name: str, extra_classes: list[int] | None = None):
    payload: dict = {
        "name": name,
        "classes": [page_class_id] + (extra_classes or []),
    }
    r = await client.post("/api/nodes/", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


async def _get_node(client, node_id: int):
    r = await client.get(f"/api/nodes/{node_id}")
    assert r.status_code == 200, r.text
    return r.json()


async def _class_class_id(client) -> int:
    r = await client.get("/api/nodes/classes")
    assert r.status_code == 200, r.text
    for node in r.json()["nodes"]:
        if node["uuid"] == SYSTEM_CLASS_UUIDS["class"]:
            return node["id"]
    raise RuntimeError("class class not found")


async def test_undo_redo_create_node(authenticated_client, test_user):
    page_class_id = test_user["page_class_id"]
    page = await _create_page(authenticated_client, page_class_id, "Undo Create")
    page_id = page["id"]

    stack = await authenticated_client.get("/api/undo/stack")
    assert stack.status_code == 200
    assert stack.json()["undo_count"] == 1

    undo = await authenticated_client.post("/api/undo/undo")
    assert undo.status_code == 200
    assert "Created" in undo.json()["description"]

    # Undo create => soft delete => GET returns 404
    get_after_undo = await authenticated_client.get(f"/api/nodes/{page_id}")
    assert get_after_undo.status_code == 404

    redo = await authenticated_client.post("/api/undo/redo")
    assert redo.status_code == 200

    get_after_redo = await authenticated_client.get(f"/api/nodes/{page_id}")
    assert get_after_redo.status_code == 200


async def test_undo_redo_update_node(authenticated_client, test_user):
    page_class_id = test_user["page_class_id"]
    page = await _create_page(authenticated_client, page_class_id, "Before")
    page_id = page["id"]

    r = await authenticated_client.put(f"/api/nodes/{page_id}", json={"name": "After"})
    assert r.status_code == 200, r.text

    undo = await authenticated_client.post("/api/undo/undo")
    assert undo.status_code == 200

    page_after_undo = await _get_node(authenticated_client, page_id)
    assert page_after_undo["name"] == "Before"

    redo = await authenticated_client.post("/api/undo/redo")
    assert redo.status_code == 200

    page_after_redo = await _get_node(authenticated_client, page_id)
    assert page_after_redo["name"] == "After"


async def test_undo_redo_move_node(authenticated_client, test_user):
    page_class_id = test_user["page_class_id"]
    parent_a = await _create_page(authenticated_client, page_class_id, "Parent A")
    parent_b = await _create_page(authenticated_client, page_class_id, "Parent B")

    block = await authenticated_client.post(
        "/api/nodes/",
        json={"name": "Block to move", "parent_id": parent_a["id"], "classes": []},
    )
    assert block.status_code == 200, block.text
    block_id = block.json()["id"]

    move = await authenticated_client.put(
        f"/api/nodes/{block_id}/move",
        json={"parent_id": parent_b["id"]},
    )
    assert move.status_code == 200, move.text

    await authenticated_client.post("/api/undo/undo")
    block_after_undo = await _get_node(authenticated_client, block_id)
    assert block_after_undo["parent_id"] == parent_a["id"]

    await authenticated_client.post("/api/undo/redo")
    block_after_redo = await _get_node(authenticated_client, block_id)
    assert block_after_redo["parent_id"] == parent_b["id"]


async def test_undo_redo_tag_link(authenticated_client, test_user):
    page_class_id = test_user["page_class_id"]
    source = await _create_page(authenticated_client, page_class_id, "Source")
    tag = await _create_page(authenticated_client, page_class_id, "Tag Page")

    add = await authenticated_client.post(
        f"/api/nodes/{source['id']}/tag-links",
        json={"target_node_id": tag["id"]},
    )
    assert add.status_code == 200, add.text

    source_after_add = await _get_node(authenticated_client, source["id"])
    assert tag["id"] in source_after_add["tags"]

    await authenticated_client.post("/api/undo/undo")
    source_after_undo = await _get_node(authenticated_client, source["id"])
    assert tag["id"] not in source_after_undo["tags"]

    await authenticated_client.post("/api/undo/redo")
    source_after_redo = await _get_node(authenticated_client, source["id"])
    assert tag["id"] in source_after_redo["tags"]


async def test_undo_redo_alias(authenticated_client, test_user):
    page_class_id = test_user["page_class_id"]
    source = await _create_page(authenticated_client, page_class_id, "Source")
    alias = await _create_page(authenticated_client, page_class_id, "Alias Page")

    add = await authenticated_client.post(
        f"/api/nodes/{source['id']}/aliases",
        json={"alias_node_id": alias["id"]},
    )
    assert add.status_code == 200, add.text

    source_after_add = await _get_node(authenticated_client, source["id"])
    alias_after_add = await _get_node(authenticated_client, alias["id"])
    assert alias["id"] in source_after_add["aliases"]
    assert alias_after_add["aliased_id"] == source["id"]

    await authenticated_client.post("/api/undo/undo")
    source_after_undo = await _get_node(authenticated_client, source["id"])
    alias_after_undo = await _get_node(authenticated_client, alias["id"])
    assert alias["id"] not in source_after_undo["aliases"]
    assert alias_after_undo["aliased_id"] is None

    await authenticated_client.post("/api/undo/redo")
    source_after_redo = await _get_node(authenticated_client, source["id"])
    alias_after_redo = await _get_node(authenticated_client, alias["id"])
    assert alias["id"] in source_after_redo["aliases"]
    assert alias_after_redo["aliased_id"] == source["id"]


async def test_undo_redo_add_remove_class(authenticated_client, test_user):
    page_class_id = test_user["page_class_id"]
    class_class_id = await _class_class_id(authenticated_client)

    custom_class = await _create_page(
        authenticated_client, page_class_id, "Custom Class", extra_classes=[class_class_id]
    )
    page = await _create_page(authenticated_client, page_class_id, "Classed Page")

    # Add class
    add = await authenticated_client.post(
        f"/api/nodes/{page['id']}/classes",
        json={"class_node_id": custom_class["id"]},
    )
    assert add.status_code == 200, add.text

    page_after_add = await _get_node(authenticated_client, page["id"])
    assert custom_class["id"] in page_after_add["classes"]

    # Undo add
    await authenticated_client.post("/api/undo/undo")
    page_after_undo_add = await _get_node(authenticated_client, page["id"])
    assert custom_class["id"] not in page_after_undo_add["classes"]

    # Redo add
    await authenticated_client.post("/api/undo/redo")
    page_after_redo_add = await _get_node(authenticated_client, page["id"])
    assert custom_class["id"] in page_after_redo_add["classes"]

    # Remove class
    remove = await authenticated_client.delete(
        f"/api/nodes/{page['id']}/classes/{custom_class['id']}"
    )
    assert remove.status_code == 200, remove.text

    page_after_remove = await _get_node(authenticated_client, page["id"])
    assert custom_class["id"] not in page_after_remove["classes"]

    # Undo remove
    await authenticated_client.post("/api/undo/undo")
    page_after_undo_remove = await _get_node(authenticated_client, page["id"])
    assert custom_class["id"] in page_after_undo_remove["classes"]

    # Redo remove
    await authenticated_client.post("/api/undo/redo")
    page_after_redo_remove = await _get_node(authenticated_client, page["id"])
    assert custom_class["id"] not in page_after_redo_remove["classes"]
