"""Tests for the node breadcrumbs endpoint, including text-property pseudo-blocks."""

import secrets

import pytest

from app.domain.entities import NodeCreateData, Property
from app.domain.entities.property import PropertyType


def _link_ast(target_uuid: str, link_uuid: str, label: str | None = None) -> str:
    """Return a block name AST containing a single node link."""
    label_field = f',"label":"{label}"' if label else ""
    return (
        '[{"type":"paragraph","children":['
        f'{{"type":"node_link","link_id":"{target_uuid}:{link_uuid}","ref_type":"node"{label_field}}}'
        ']}]'
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_breadcrumbs_resolve_links_inside_block_names(
    auth_client,
    node_repository,
    test_user,
):
    """A block whose name is a node link should display the target's name in breadcrumbs."""
    page_class_id = test_user["page_class_id"]
    suffix = secrets.token_hex(4)

    # Page A is the root; Page B is the link target.
    page_a = await node_repository.create(
        NodeCreateData(name=f"Root Page {suffix}", classes=[page_class_id])
    )
    page_b = await node_repository.create(
        NodeCreateData(name=f"Target Page {suffix}", classes=[page_class_id])
    )
    assert page_a.id is not None
    assert page_b.id is not None
    assert page_b.uuid is not None

    # Block C's name is a link to Page B.
    link_uuid = secrets.token_hex(16)
    block_c = await node_repository.create(
        NodeCreateData(name=_link_ast(page_b.uuid, link_uuid), parent_id=page_a.id)
    )
    assert block_c.id is not None

    # Block D is nested under Block C.
    block_d = await node_repository.create(
        NodeCreateData(name="Nested block", parent_id=block_c.id)
    )
    assert block_d.id is not None

    response = await auth_client.get(f"/api/nodes/{block_d.uuid}/breadcrumbs")
    assert response.status_code == 200

    breadcrumbs = response.json()["breadcrumbs"]
    ids = [b["id"] for b in breadcrumbs]

    # Order should be: root page -> block C (link block).
    assert page_a.id in ids
    assert block_c.id in ids
    assert block_d.id not in ids  # current node is excluded

    block_c_item = next(b for b in breadcrumbs if b["id"] == block_c.id)
    assert block_c_item["name"] == _link_ast(page_b.uuid, link_uuid)
    assert block_c_item["display_name"] == f"Target Page {suffix}"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_breadcrumbs_resolve_links_inside_block_names_recursively(
    auth_client,
    node_repository,
    test_user,
):
    """A link target whose name is also a link should resolve recursively in breadcrumbs."""
    page_class_id = test_user["page_class_id"]
    suffix = secrets.token_hex(4)

    # Page C is the final link target; Page B's name links to Page C;
    # Block A's name links to Page B.
    page_c = await node_repository.create(
        NodeCreateData(name=f"Final Page {suffix}", classes=[page_class_id])
    )
    page_b = await node_repository.create(
        NodeCreateData(name=_link_ast(page_c.uuid, secrets.token_hex(16)), classes=[page_class_id])
    )
    assert page_b.id is not None
    assert page_b.uuid is not None

    page_a = await node_repository.create(
        NodeCreateData(name=f"Root Page {suffix}", classes=[page_class_id])
    )
    block_x = await node_repository.create(
        NodeCreateData(name=_link_ast(page_b.uuid, secrets.token_hex(16)), parent_id=page_a.id)
    )
    assert block_x.id is not None

    block_y = await node_repository.create(
        NodeCreateData(name="Nested block", parent_id=block_x.id)
    )
    assert block_y.id is not None

    response = await auth_client.get(f"/api/nodes/{block_y.uuid}/breadcrumbs")
    assert response.status_code == 200

    breadcrumbs = response.json()["breadcrumbs"]
    block_x_item = next(b for b in breadcrumbs if b["id"] == block_x.id)
    # Block X -> Page B -> Page C, so the resolved name should be "Final Page ...".
    assert block_x_item["display_name"] == f"Final Page {suffix}"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_breadcrumbs_include_text_property_pseudo_block(
    auth_client,
    node_repository,
    property_repository,
    test_user,
):
    """A block inside a text-property value block should see the property in its breadcrumbs."""
    page_class_id = test_user["page_class_id"]

    suffix = secrets.token_hex(4)

    # Create a page and a text property
    page = await node_repository.create(
        NodeCreateData(name=f"Source Page {suffix}", classes=[page_class_id])
    )
    assert page.id is not None

    prop = await property_repository.create(
        Property(name=f"Description {suffix}", type=PropertyType.TEXT, icon="mdi mdi-text-box")
    )
    assert prop.id is not None

    # The text property value is a block whose parent is the owning page
    text_block = await node_repository.create(
        NodeCreateData(name="Text property contents", parent_id=page.id)
    )
    assert text_block.id is not None

    await property_repository.set_relation_value(page.id, prop.id, text_block.id)

    # A child block nested inside the text property value
    child_block = await node_repository.create(
        NodeCreateData(name="Child block", parent_id=text_block.id)
    )
    assert child_block.id is not None

    response = await auth_client.get(f"/api/nodes/{child_block.uuid}/breadcrumbs")
    assert response.status_code == 200

    breadcrumbs = response.json()["breadcrumbs"]
    ids = [b["id"] for b in breadcrumbs]

    # Order should be: page -> property pseudo-block -> text value block
    assert page.id in ids
    assert text_block.id in ids
    assert prop.id in ids

    page_idx = ids.index(page.id)
    prop_idx = ids.index(prop.id)
    text_idx = ids.index(text_block.id)

    assert page_idx < prop_idx < text_idx

    prop_item = breadcrumbs[prop_idx]
    assert prop_item["is_property"] is True
    assert prop_item["property_id"] == prop.id
    assert prop_item["name"] == prop.name
    assert prop_item["icon"] == "mdi mdi-text-box"
    assert prop_item["is_page"] is False


@pytest.mark.asyncio
@pytest.mark.integration
async def test_breadcrumbs_for_text_property_value_block_includes_property(
    auth_client,
    node_repository,
    property_repository,
    test_user,
):
    """The text-property value block itself should also show the property via propertyContext on the client.

    This test verifies the backend part: ancestors do not include the property,
    so the client-side propertyContext is required for the focused value block view.
    """
    page_class_id = test_user["page_class_id"]

    suffix = secrets.token_hex(4)

    page = await node_repository.create(
        NodeCreateData(name=f"Source Page {suffix}", classes=[page_class_id])
    )
    assert page.id is not None

    prop = await property_repository.create(
        Property(name=f"Notes {suffix}", type=PropertyType.TEXT)
    )
    assert prop.id is not None

    text_block = await node_repository.create(
        NodeCreateData(name="Notes value", parent_id=page.id)
    )
    assert text_block.id is not None

    await property_repository.set_relation_value(page.id, prop.id, text_block.id)

    response = await auth_client.get(f"/api/nodes/{text_block.uuid}/breadcrumbs")
    assert response.status_code == 200

    breadcrumbs = response.json()["breadcrumbs"]
    ids = [b["id"] for b in breadcrumbs]

    # The current node is excluded from ancestors, so only the page is returned
    assert ids == [page.id]
    assert all(b["is_property"] is False for b in breadcrumbs)
