"""Security tests for QueryAST execution."""
import pytest


class TestQueryAstFlagNameSecurity:
    """Tests for the QueryAST flag_name SQL-injection whitelist."""

    @pytest.mark.asyncio
    async def test_execute_query_rejects_malicious_flag_name(self, authenticated_client):
        """A malicious flag_name must return HTTP 400 and execute no query."""
        malicious_flag = "is_page; DROP TABLE node; --"
        payload = {
            "query_ast": {
                "type": "query",
                "version": "1.0",
                "scope": {"type": "scope", "scope_type": "entire_workspace"},
                "root_group": {
                    "type": "group",
                    "logic": "AND",
                    "children": [
                        {
                            "type": "condition",
                            "condition_type": "flag",
                            "flag_name": malicious_flag,
                            "value": True,
                        }
                    ],
                },
            }
        }

        response = await authenticated_client.post("/api/nodes/views/execute", json=payload)

        assert response.status_code == 400
        body = response.json()
        assert "error" in body
        assert "invalid flag_name" in body["error"]["message"].lower()
        assert body.get("nodes") is None

    @pytest.mark.asyncio
    async def test_execute_query_accepts_valid_flag_name(self, authenticated_client):
        """A whitelisted flag_name must execute normally and return results."""
        payload = {
            "query_ast": {
                "type": "query",
                "version": "1.0",
                "scope": {"type": "scope", "scope_type": "entire_workspace"},
                "root_group": {
                    "type": "group",
                    "logic": "AND",
                    "children": [
                        {
                            "type": "condition",
                            "condition_type": "flag",
                            "flag_name": "is_page",
                            "value": True,
                        }
                    ],
                },
            }
        }

        response = await authenticated_client.post("/api/nodes/views/execute", json=payload)

        assert response.status_code == 200
        body = response.json()
        assert "nodes" in body
        assert isinstance(body["nodes"], list)
        # The workspace has at least the system page class node.
        assert len(body["nodes"]) >= 1
        assert all(node.get("is_page") is True for node in body["nodes"])
