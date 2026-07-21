"""Business logic for the external agent API.

All operations go through ``WorkspaceStore`` so they participate in the same
local-first operation log as frontend clients.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.features.workspaces.port import WorkspaceRepository

from . import schemas


def _text_ast(text: str) -> list[dict[str, Any]]:
    """Return a minimal paragraph AST representing ``text``."""
    return [
        {
            "type": "paragraph",
            "children": [{"text": text}],
        }
    ]


def _extract_text(value: Any) -> str:
    """Extract plain text from a content AST by walking leaf ``text`` nodes.

    Some migrated content stores a stringified AST inside a single ``text``
    leaf (e.g. ``{"text": "[{\"type\": \"paragraph\", ...}]"}``). When that
    happens, parse the embedded JSON and continue extracting.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("[") or stripped.startswith("{"):
            try:
                value = json.loads(stripped)
            except ValueError:
                return stripped
        else:
            return stripped
    if isinstance(value, dict):
        text = value.get("text")
        if isinstance(text, str):
            # The text leaf may itself contain a stringified AST.
            return _extract_text(text)
        children = value.get("children")
        if isinstance(children, list):
            return _extract_text(children)
        return ""
    if isinstance(value, list):
        return "".join(_extract_text(child) for child in value).strip()
    return str(value).strip()


def _node_title(content: Any) -> str:
    """Return a human-readable title from node content."""
    text = _extract_text(content)
    return text or "untitled"


class AgentService:
    """Service exposing read/write note operations to external agents."""

    def __init__(
        self,
        store: WorkspaceStore,
        workspace_repo: WorkspaceRepository,
    ) -> None:
        self.store = store
        self.workspace_repo = workspace_repo

    # --------------------------------------------------------------------------
    # Workspace helpers
    # --------------------------------------------------------------------------

    @staticmethod
    def _workspace_role(row: dict) -> str:
        if row.get("is_owner"):
            return "owner"
        if row.get("s_can_write"):
            return "editor"
        if row.get("s_can_read"):
            return "viewer"
        return "owner"

    async def list_workspaces(self, user_id: int) -> list[schemas.WorkspaceListItem]:
        """List workspaces accessible to ``user_id``."""
        rows = await self.workspace_repo.list_workspaces(user_id)
        return [
            schemas.WorkspaceListItem(
                uuid=str(row["uuid"]),
                name=str(row["name"]),
                role=self._workspace_role(dict(row)),
            )
            for row in rows
        ]

    async def get_workspace(
        self, workspace_uuid: str, user_id: int
    ) -> schemas.WorkspaceDetail:
        """Return details for a single workspace."""
        rows = await self.workspace_repo.list_workspaces(user_id)
        for row in rows:
            if str(row["uuid"]) == workspace_uuid:
                return schemas.WorkspaceDetail(
                    uuid=str(row["uuid"]),
                    name=str(row["name"]),
                    role=self._workspace_role(dict(row)),
                )
        raise ValueError("Workspace not found or access denied")

    # --------------------------------------------------------------------------
    # Node read helpers
    # --------------------------------------------------------------------------

    async def search_nodes(
        self,
        q: str,
        kind: str | None,
        limit: int,
    ) -> list[schemas.NodeListItem]:
        """Search nodes by title/content."""
        await self.store.sync()
        pattern = f"%{q}%"
        rows = await self.store.query(
            """
            SELECT id, kind, content, created_at, updated_at
            FROM node
            WHERE workspace_id = ?
              AND (? IS NULL OR kind = ?)
              AND content LIKE ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (self.store.workspace_id, kind, kind, pattern, limit),
        )
        return [
            schemas.NodeListItem(
                id=row["id"],
                kind=row["kind"],
                title=_node_title(json.loads(row["content"])),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
            for row in rows
        ]

    async def get_node(self, node_id: str) -> schemas.NodeDetail:
        """Return full details for a node."""
        await self.store.sync()
        node_rows = await self.store.query(
            """
            SELECT id, kind, content, class_ids, parent_id, created_at, updated_at
            FROM node
            WHERE id = ? AND workspace_id = ?
            """,
            (node_id, self.store.workspace_id),
        )
        if not node_rows:
            raise ValueError("Node not found")
        node = node_rows[0]

        content = json.loads(node["content"])
        class_ids = json.loads(node["class_ids"])

        property_rows = await self.store.query(
            """
            SELECT pv.property_schema_id, COALESCE(ps.name, '') AS name, pv.value
            FROM property_value pv
            LEFT JOIN property_schema ps ON ps.id = pv.property_schema_id
            WHERE pv.node_id = ?
            ORDER BY pv.idx
            """,
            (node_id,),
        )
        properties = [
            schemas.NodePropertyItem(
                schema_id=row["property_schema_id"],
                name=row["name"] or "",
                value=json.loads(row["value"]),
            )
            for row in property_rows
        ]

        child_rows = await self.store.query(
            """
            SELECT n.id, n.kind, n.content
            FROM node_child_order nco
            JOIN node n ON n.id = nco.child_id
            WHERE nco.parent_id = ?
            ORDER BY nco.position
            """,
            (node_id,),
        )
        children = [
            schemas.NodeChildItem(
                id=row["id"],
                kind=row["kind"],
                title=_node_title(json.loads(row["content"])),
            )
            for row in child_rows
        ]

        return schemas.NodeDetail(
            id=node["id"],
            kind=node["kind"],
            content=content,
            properties=properties,
            classes=class_ids,
            parent_id=node["parent_id"],
            children=children,
            created_at=node["created_at"],
            updated_at=node["updated_at"],
        )

    async def get_references(self, node_id: str) -> schemas.ReferencesResponse:
        """Return outgoing references and backlinks for a node."""
        await self.store.sync()

        ref_rows = await self.store.query(
            """
            SELECT e.id, e.target_id, e.type
            FROM edge e
            WHERE e.source_id = ? AND e.workspace_id = ?
            """,
            (node_id, self.store.workspace_id),
        )
        references: list[schemas.ReferenceItem] = []
        for row in ref_rows:
            target_rows = await self.store.query(
                "SELECT content FROM node WHERE id = ?",
                (row["target_id"],),
            )
            title = _node_title(json.loads(target_rows[0]["content"])) if target_rows else ""
            references.append(
                schemas.ReferenceItem(
                    id=row["id"],
                    target_id=row["target_id"],
                    title=title,
                    type=row["type"],
                )
            )

        backlink_rows = await self.store.query(
            """
            SELECT e.id, e.source_id, e.type
            FROM edge e
            WHERE e.target_id = ? AND e.workspace_id = ?
            """,
            (node_id, self.store.workspace_id),
        )
        backlinks: list[schemas.BacklinkItem] = []
        for row in backlink_rows:
            source_rows = await self.store.query(
                "SELECT content FROM node WHERE id = ?",
                (row["source_id"],),
            )
            title = _node_title(json.loads(source_rows[0]["content"])) if source_rows else ""
            backlinks.append(
                schemas.BacklinkItem(
                    id=row["id"],
                    source_id=row["source_id"],
                    title=title,
                    type=row["type"],
                )
            )

        return schemas.ReferencesResponse(
            references=references,
            backlinks=backlinks,
        )

    async def get_activity(
        self,
        node_id: str,
        since: datetime | None,
    ) -> list[schemas.ActivityItem]:
        """Return activity log entries for a node, newest first."""
        await self.store.sync()
        params: tuple[Any, ...] = (node_id,)
        since_sql = ""
        if since is not None:
            since_sql = "AND timestamp >= ?"
            params = (node_id, since.isoformat())
        rows = await self.store.query(
            f"""
            SELECT id, action, details, timestamp
            FROM activity_log
            WHERE node_id = ? {since_sql}
            ORDER BY timestamp DESC
            """,
            params,
        )
        return [
            schemas.ActivityItem(
                id=row["id"],
                action=row["action"],
                details=json.loads(row["details"]) if row["details"] else None,
                timestamp=row["timestamp"],
            )
            for row in rows
        ]

    # --------------------------------------------------------------------------
    # Node write helpers
    # --------------------------------------------------------------------------

    async def create_node(
        self,
        kind: str,
        parent_id: str | None,
        title: str | None,
        class_ids: list[str] | None,
        initial_content: Any,
    ) -> str:
        """Create a node and optionally seed its content/title."""
        node_id = uuidv7()
        content = initial_content
        if title is not None:
            content = _text_ast(title)
        await self.store.create_node(
            node_id,
            kind,
            parent_id=parent_id,
            initial_content=content,
            class_ids=class_ids,
        )
        return node_id

    async def update_node(
        self,
        node_id: str,
        title: str | None,
        content: Any,
    ) -> None:
        """Update a node's content/title."""
        if content is not None:
            await self.store.update_content(node_id, content)
        elif title is not None:
            await self.store.update_content(node_id, _text_ast(title))

    async def set_property(
        self,
        node_id: str,
        schema_id: str,
        value: Any,
    ) -> None:
        """Set a property value on a node."""
        property_value_id = uuidv7()
        await self.store.set_property(
            property_value_id,
            node_id,
            schema_id,
            value,
        )

    async def append_note(self, node_id: str, text: str) -> str:
        """Append a child text block to a node."""
        child_id = uuidv7()
        await self.store.create_node(
            child_id,
            "block",
            parent_id=node_id,
            initial_content=_text_ast(text),
        )
        return child_id
