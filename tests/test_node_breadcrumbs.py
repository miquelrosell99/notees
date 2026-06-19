"""Tests for the node breadcrumbs endpoint, including text-property pseudo-blocks."""

import secrets

import pytest

from app.domain.entities import NodeCreateData, Property
from app.domain.entities.property import PropertyType


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

    response = await auth_client.get(f"/api/nodes/{child_block.id}/breadcrumbs")
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

    response = await auth_client.get(f"/api/nodes/{text_block.id}/breadcrumbs")
    assert response.status_code == 200

    breadcrumbs = response.json()["breadcrumbs"]
    ids = [b["id"] for b in breadcrumbs]

    # The current node is excluded from ancestors, so only the page is returned
    assert ids == [page.id]
    assert all(b["is_property"] is False for b in breadcrumbs)
