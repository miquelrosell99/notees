"""Integration tests for date range properties and inline links."""

from __future__ import annotations

import json
from datetime import date

import pytest

from app.domain.entities.constants import generate_day_uuid
from app.domain.entities.node import NodeCreateData, NodeUpdateData
from app.domain.entities.property import Property, PropertyScope, PropertyType

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_set_date_range_property_value(node_service, property_repository):
    """Setting a date_range property normalizes and stores JSON in the scalar table."""
    page = await node_service.create_page("Date Range Property Test")
    prop = Property(
        name="When",
        type=PropertyType.DATE_RANGE,
        scope=PropertyScope.GLOBAL,
    )
    created = await property_repository.create(prop)

    await node_service.update_node(
        page.id,
        NodeUpdateData(),
        properties={
            created.id: {
                "start": "2025-06-10",
                "end": "2025-06-15",
                "granularity": "day",
            },
        },
    )

    values = await property_repository.get_all_property_values(page.id)
    prop_data = values.get(created.id)
    assert prop_data is not None
    assert len(prop_data["values"]) == 1
    scalar = prop_data["values"][0]
    stored = json.loads(scalar.value_text)
    assert stored["start"] == "2025-06-10"
    assert stored["end"] == "2025-06-15"
    assert stored["granularity"] == "day"
    assert stored["start_uuid"] == generate_day_uuid(date(2025, 6, 10))
    assert stored["end_uuid"] == generate_day_uuid(date(2025, 6, 15))


@pytest.mark.asyncio
async def test_inline_date_range_creates_backlinks_to_journal_pages(node_service, link_service):
    """A date_range AST node inside block content creates node_link rows for both endpoints."""
    start_date = date(2025, 6, 10)
    end_date = date(2025, 6, 15)
    start_uuid = generate_day_uuid(start_date)
    end_uuid = generate_day_uuid(end_date)

    # Ensure the endpoint journal pages exist.
    start_day = await node_service.get_or_create_day_node(start_date)
    end_day = await node_service.get_or_create_day_node(end_date)
    assert start_day is not None
    assert end_day is not None

    parent = await node_service.create_page("Parent Page")
    content = json.dumps(
        [
            {
                "type": "paragraph",
                "children": [
                    {
                        "type": "date_range",
                        "start": "2025-06-10",
                        "end": "2025-06-15",
                        "granularity": "day",
                        "start_uuid": start_uuid,
                        "end_uuid": end_uuid,
                    },
                ],
            },
        ]
    )

    block = await node_service.create_node(
        NodeCreateData(name=content, parent_id=parent.id),
    )

    start_backlinks = [link.source_node_id for link in await link_service.get_backlinks(start_day.id)]
    end_backlinks = [link.source_node_id for link in await link_service.get_backlinks(end_day.id)]

    assert block.id in start_backlinks
    assert block.id in end_backlinks
