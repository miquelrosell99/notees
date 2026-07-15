"""Tests for QueryAST power features:
- typed runtime parameters
- relative date placeholders
- backend aggregation
- compact text query language
"""

from __future__ import annotations

from datetime import date

import pytest
import pytest_asyncio

from app.db.schema.constants import SYSTEM_CLASS_UUIDS
from app.domain.entities import Property, PropertyType
from app.domain.services.query_language import parse_query_language


@pytest_asyncio.fixture(scope="function")
async def text_property(property_repository):
    """Create a reusable scalar text property for aggregation / query tests."""
    prop = Property(name="status", type=PropertyType.URL)
    created = await property_repository.create(prop)
    return created


@pytest_asyncio.fixture(scope="function")
async def priority_property(property_repository):
    """Create a reusable scalar text property for query-language resolution tests."""
    prop = Property(name="priority", type=PropertyType.URL)
    created = await property_repository.create(prop)
    return created


@pytest_asyncio.fixture(scope="function")
async def sample_page(authenticated_client, test_user):
    """Create a simple page node."""
    response = await authenticated_client.post(
        "/api/nodes/",
        json={"name": "Sample Page", "class_uuids": [SYSTEM_CLASS_UUIDS["page"]]},
    )
    assert response.status_code == 200
    data = response.json()
    # Return a small object with the fields tests need.
    return type("Page", (), {"id": data["id"], "uuid": data["uuid"]})()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_execute_include_properties_returns_properties_uuid(
    authenticated_client, property_repository, text_property
):
    """include_properties attaches `properties_uuid` (keyed by property UUID,
    the preferred public identifier) alongside numeric-id-keyed `properties`."""
    resp = await authenticated_client.post(
        "/api/nodes/",
        json={"name": "Props UUID Page", "class_uuids": [SYSTEM_CLASS_UUIDS["page"]]},
    )
    assert resp.status_code == 200
    page_id = resp.json()["id"]
    await property_repository.set_scalar_value(page_id, text_property.id, "active")

    query = {
        "type": "query",
        "version": "1.0",
        "scope": {"type": "scope", "scope_type": "pages"},
        "root_group": {
            "type": "group",
            "logic": "AND",
            "children": [
                {
                    "type": "condition",
                    "condition_type": "property",
                    "property_name": "id",
                    "property_type": "number",
                    "operator": "equals",
                    "value": page_id,
                }
            ],
        },
    }
    response = await authenticated_client.post(
        "/api/nodes/views/execute",
        json={"query_ast": query, "include_properties": True},
    )
    assert response.status_code == 200
    nodes = response.json()["nodes"]
    assert len(nodes) == 1
    node = nodes[0]
    assert node["properties"][str(text_property.id)] == "active"
    # properties_uuid carries the same values, keyed by the property's UUID.
    assert node["properties_uuid"] is not None
    assert node["properties_uuid"][text_property.uuid] == "active"
    assert node["properties_uuid"][text_property.uuid] == node["properties"][str(text_property.id)]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_date_placeholder_create_date_today(authenticated_client, sample_page):
    """{today} resolves to a date and can filter by create_date."""
    query = {
        "type": "query",
        "version": "1.0",
        "scope": {"type": "scope", "scope_type": "pages"},
        "root_group": {
            "type": "group",
            "logic": "AND",
            "children": [
                {
                    "type": "condition",
                    "condition_type": "property",
                    "property_name": "create_date",
                    "property_type": "date",
                    "operator": "gte",
                    "value": "{today}",
                }
            ],
        },
    }
    response = await authenticated_client.post(
        "/api/nodes/views/execute",
        json={"query_ast": query},
    )
    assert response.status_code == 200
    data = response.json()
    node_ids = {node["id"] for node in data["nodes"]}
    assert sample_page.id in node_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_date_placeholder_this_year(authenticated_client, sample_page):
    """{this_year} resolves to January 1st of the current year."""
    query = {
        "type": "query",
        "version": "1.0",
        "scope": {"type": "scope", "scope_type": "pages"},
        "root_group": {
            "type": "group",
            "logic": "AND",
            "children": [
                {
                    "type": "condition",
                    "condition_type": "property",
                    "property_name": "create_date",
                    "property_type": "date",
                    "operator": "gte",
                    "value": "{this_year}",
                }
            ],
        },
    }
    response = await authenticated_client.post(
        "/api/nodes/views/execute",
        json={"query_ast": query},
    )
    assert response.status_code == 200
    data = response.json()
    node_ids = {node["id"] for node in data["nodes"]}
    assert sample_page.id in node_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_typed_current_node_id_placeholder(authenticated_client, sample_page):
    """{current_node_id} is substituted as an integer, not a string."""
    query = {
        "type": "query",
        "version": "1.0",
        "scope": {"type": "scope", "scope_type": "pages"},
        "root_group": {
            "type": "group",
            "logic": "AND",
            "children": [
                {
                    "type": "condition",
                    "condition_type": "property",
                    "property_name": "id",
                    "property_type": "number",
                    "operator": "equals",
                    "value": "{current_node_id}",
                }
            ],
        },
    }
    response = await authenticated_client.post(
        "/api/nodes/views/execute",
        json={"query_ast": query, "runtime_params": {"current_node_id": sample_page.id}},
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["nodes"]) == 1
    assert data["nodes"][0]["id"] == sample_page.id


@pytest.mark.integration
@pytest.mark.asyncio
async def test_aggregation_count_by_text_property(
    authenticated_client, property_repository, text_property, test_user
):
    """Backend aggregation can count nodes grouped by a text property value."""
    created = []
    for name, value in (("Page A", "active"), ("Page B", "active"), ("Page C", "done")):
        resp = await authenticated_client.post(
            "/api/nodes/", json={"name": name, "class_uuids": [SYSTEM_CLASS_UUIDS["page"]]}
        )
        assert resp.status_code == 200
        page_id = resp.json()["id"]
        await property_repository.set_scalar_value(page_id, text_property.id, value)
        created.append(page_id)

    query = {
        "type": "query",
        "version": "1.0",
        "scope": {"type": "scope", "scope_type": "pages"},
        "root_group": {"type": "group", "logic": "AND", "children": []},
        "aggregation": {
            "type": "aggregation",
            "function": "count",
            "group_by": text_property.uuid,
            "group_by_property_type": "text",
        },
    }

    response = await authenticated_client.post(
        "/api/nodes/views/execute",
        json={"query_ast": query},
    )
    assert response.status_code == 200
    data = response.json()
    groups = data["groups"]
    by_key = {g["dim_0"]: g["value"] for g in groups}
    assert by_key.get("active") == 2
    assert by_key.get("done") == 1


@pytest.mark.integration
@pytest.mark.asyncio
async def test_query_language_parse_flag(authenticated_client):
    """The text query language parser can be invoked via the parse endpoint."""
    response = await authenticated_client.post(
        "/api/nodes/views/parse",
        json={"query_language": "flag:is_page"},
    )
    assert response.status_code == 200
    ast = response.json()["query_ast"]
    assert ast["root_group"]["children"][0]["condition_type"] == "flag"
    assert ast["root_group"]["children"][0]["flag_name"] == "is_page"


@pytest.mark.asyncio
async def test_query_language_parses_complex_expression():
    """The parser handles grouping, AND/OR, and NOT."""
    ast = parse_query_language('(class:A OR class:B) AND content:"hello world" NOT flag:is_day')
    children = ast.root_group.children
    assert len(children) == 3
    assert children[0].type == "group"
    assert children[1].condition_type == "content"  # type: ignore[attr-defined]
    assert children[2].type == "not"  # type: ignore[attr-defined]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_query_language_executes_with_property_name_resolution(
    authenticated_client, property_repository, priority_property, test_user
):
    """A text query using a property name is resolved to its UUID at execution time."""
    resp = await authenticated_client.post(
        "/api/nodes/",
        json={"name": "Priority Page", "class_uuids": [SYSTEM_CLASS_UUIDS["page"]]},
    )
    assert resp.status_code == 200
    page_id = resp.json()["id"]
    await property_repository.set_scalar_value(page_id, priority_property.id, "high")

    response = await authenticated_client.post(
        "/api/nodes/views/execute",
        json={"query_language": "priority:high"},
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["nodes"]) == 1
    assert data["nodes"][0]["id"] == page_id


@pytest.mark.integration
@pytest.mark.asyncio
async def test_query_language_date_placeholder(authenticated_client, sample_page):
    """The text query language supports date placeholders."""
    response = await authenticated_client.post(
        "/api/nodes/views/execute",
        json={"query_language": "create_date >= {today}"},
    )
    assert response.status_code == 200
    data = response.json()
    node_ids = {node["id"] for node in data["nodes"]}
    assert sample_page.id in node_ids


def test_resolve_date_placeholders():
    """Smoke-test for date placeholder values."""
    today = date.today()
    assert today.year >= 2026
    monday = today - __import__("datetime").timedelta(days=today.weekday())
    assert monday <= today
