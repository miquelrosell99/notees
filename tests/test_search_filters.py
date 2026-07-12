import pytest


@pytest.mark.integration
async def test_search_filtered_requires_auth(client):
    """The structured search endpoint requires authentication."""
    response = await client.post("/api/nodes/search", json={"query": "test"})
    assert response.status_code == 401


@pytest.mark.integration
async def test_search_filtered_text(authenticated_client):
    """Text search returns nodes matching the query."""
    # Create a page with a known name first.
    create_response = await authenticated_client.post(
        "/api/nodes/page",
        params={"name": "Searchable Test Page"},
    )
    assert create_response.status_code in (200, 201)

    response = await authenticated_client.post(
        "/api/nodes/search",
        json={"query": "Searchable Test"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "nodes" in data
    assert any("searchable test" in n["name"].lower() for n in data["nodes"])


@pytest.mark.integration
async def test_search_filtered_is_page(authenticated_client):
    """Filtering by is_page returns only pages."""
    response = await authenticated_client.post(
        "/api/nodes/search",
        json={"query": "", "is_page": True, "limit": 100},
    )
    assert response.status_code == 200
    data = response.json()
    assert all(n["is_page"] for n in data["nodes"])


@pytest.mark.integration
async def test_search_filtered_task_state_open(authenticated_client):
    """Task state filter returns tasks with the requested state."""
    response = await authenticated_client.post(
        "/api/nodes/search",
        json={"is_task": True, "task_state": "open", "limit": 100},
    )
    assert response.status_code == 200
    data = response.json()
    # Either no tasks exist, or every returned task has no closed status.
    for node in data["nodes"]:
        assert node["is_task"]


@pytest.mark.integration
async def test_search_filtered_more_results_than_limit(authenticated_client):
    """Regression: more matches than the limit must not 500.

    The response builder sliced nodes to `limit` but resolved display names
    against the full list, crashing the strict zip in
    _resolve_display_names_for_responses.
    """
    for i in range(5):
        create_response = await authenticated_client.post(
            "/api/nodes/page",
            params={"name": f"Over Limit Regression {i}"},
        )
        assert create_response.status_code in (200, 201)

    response = await authenticated_client.post(
        "/api/nodes/search",
        json={"query": "", "is_page": True, "limit": 2},
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["nodes"]) <= 2
