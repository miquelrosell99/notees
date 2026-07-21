"""Integration tests for the external agent REST API."""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import AsyncClient

from app.features.auth import auth as auth_module

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def agent_client(
    client: AsyncClient,
    test_user: dict,
) -> AsyncClient:
    """Return an async client authenticated with an API key."""
    key_record = await auth_module.create_api_key(
        int(test_user["id"]),
        "test-agent-key",
        scopes=["read", "write"],
    )
    client.headers["X-API-Key"] = key_record["key"]
    return client


@pytest_asyncio.fixture
async def read_only_agent_client(
    client: AsyncClient,
    test_user: dict,
) -> AsyncClient:
    """Return an async client authenticated with a read-only API key."""
    key_record = await auth_module.create_api_key(
        int(test_user["id"]),
        "test-read-key",
        scopes=["read"],
    )
    client.headers["X-API-Key"] = key_record["key"]
    return client


class TestAgentWorkspaces:
    async def test_list_workspaces(self, agent_client: AsyncClient, test_user: dict) -> None:
        response = await agent_client.get("/api/agents/v1/workspaces")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        assert data[0]["uuid"] == test_user["workspace_uuid"]
        assert data[0]["name"] == "Default"
        assert data[0]["role"] == "owner"

    async def test_get_workspace(self, agent_client: AsyncClient, test_user: dict) -> None:
        response = await agent_client.get(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}"
        )
        assert response.status_code == 200
        data = response.json()
        assert data["uuid"] == test_user["workspace_uuid"]
        assert data["name"] == "Default"
        assert data["role"] == "owner"

    async def test_get_workspace_not_found(
        self, agent_client: AsyncClient
    ) -> None:
        response = await agent_client.get(
            "/api/agents/v1/workspaces/00000000-0000-0000-0000-000000000000"
        )
        assert response.status_code == 404


class TestAgentNodes:
    async def test_search_nodes(self, agent_client: AsyncClient, test_user: dict) -> None:
        response = await agent_client.get(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}/nodes?q=Inbox"
        )
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert any(node["title"] == "Inbox" for node in data)

    async def test_get_node(self, agent_client: AsyncClient, test_user: dict) -> None:
        search_response = await agent_client.get(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}/nodes?q=Inbox"
        )
        nodes = search_response.json()
        inbox = next(node for node in nodes if node["title"] == "Inbox")

        response = await agent_client.get(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}/nodes/{inbox['id']}"
        )
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == inbox["id"]
        assert data["kind"] == "page"
        assert "Inbox" in data["content"][0]["children"][0]["text"]

    async def test_create_node(self, agent_client: AsyncClient, test_user: dict) -> None:
        response = await agent_client.post(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}/nodes",
            json={"kind": "page", "title": "Agent Page"},
        )
        assert response.status_code == 201
        data = response.json()
        assert "id" in data

        search_response = await agent_client.get(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}/nodes?q=Agent+Page"
        )
        assert search_response.status_code == 200
        nodes = search_response.json()
        assert any(node["title"] == "Agent Page" for node in nodes)

    async def test_write_requires_write_scope(
        self, read_only_agent_client: AsyncClient, test_user: dict
    ) -> None:
        response = await read_only_agent_client.post(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}/nodes",
            json={"kind": "page", "title": "Should Fail"},
        )
        assert response.status_code == 403

    async def test_append_note(self, agent_client: AsyncClient, test_user: dict) -> None:
        search_response = await agent_client.get(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}/nodes?q=Inbox"
        )
        inbox = next(node for node in search_response.json() if node["title"] == "Inbox")

        response = await agent_client.post(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}/nodes/{inbox['id']}/notes",
            json={"text": "A quick note"},
        )
        assert response.status_code == 201
        child_id = response.json()["id"]

        detail_response = await agent_client.get(
            f"/api/agents/v1/workspaces/{test_user['workspace_uuid']}/nodes/{inbox['id']}"
        )
        children = detail_response.json()["children"]
        assert any(child["id"] == child_id for child in children)
