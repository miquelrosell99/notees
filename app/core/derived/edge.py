"""Edge (reference) derivation from inline node content."""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from app.core.operation import Operation
from app.core.uuid import uuidv7


def extract_ref_targets(content: list[dict[str, Any]]) -> dict[str, str | None]:
    """Return map target_id -> label from inline refs in the content AST."""
    targets: dict[str, str | None] = {}

    def _visit(node: Any) -> None:
        if not isinstance(node, dict):
            return
        ctype = node.get("type")
        if ctype == "ref" and node.get("targetId"):
            targets[node["targetId"]] = node.get("label")
        elif ctype == "node_link" and node.get("link_id"):
            # Migrated node_link entries store the target in the first segment of
            # ``link_id`` (``target`` or ``target:linkUuid``).
            link_id = str(node["link_id"])
            target_id = link_id.split(":", 1)[0]
            if target_id:
                targets[target_id] = node.get("label")
        elif ctype == "text" and isinstance(node.get("text"), str):
            text = node["text"]
            for match in re.finditer(r"\[\[([^\]]+)\]\]", text):
                targets[match.group(1)] = None
        children = node.get("children")
        if isinstance(children, list):
            for child in children:
                _visit(child)

    for child in content:
        _visit(child)
    return targets


def rebuild_edges_for_node(conn: sqlite3.Connection, op: Operation) -> None:
    """Synchronise ``edge`` rows of type ``reference`` for ``op.payload.nodeId``."""
    node_id = op.payload["nodeId"]
    workspace_id = op.envelope.workspace_id
    row = conn.execute("SELECT content FROM node WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        return
    content = json.loads(row[0])
    desired = extract_ref_targets(content)

    existing = conn.execute(
        "SELECT id, target_id, metadata FROM edge WHERE source_id = ? AND type = ?",
        (node_id, "reference"),
    ).fetchall()
    existing_targets = {row["target_id"]: row for row in existing}

    for target_id, metadata in desired.items():
        if target_id in existing_targets:
            continue
        conn.execute(
            """
            INSERT INTO edge (
                id, workspace_id, source_id, target_id, type,
                property_schema_id, metadata, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                uuidv7(),
                workspace_id,
                node_id,
                target_id,
                "reference",
                None,
                json.dumps({"label": metadata}),
                op.envelope.timestamp.isoformat() if op.envelope.timestamp else None,
            ),
        )

    for target_id, row in existing_targets.items():
        if target_id not in desired:
            conn.execute("DELETE FROM edge WHERE id = ?", (row["id"],))
