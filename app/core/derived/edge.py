"""Edge (reference) and node_link registry derivation from inline node content."""

from __future__ import annotations

import json
import re
import sqlite3
import uuid as uuid_module
from typing import Any

from app.core.operation import Operation
from app.core.uuid import uuidv7


# Namespace for deterministic link UUIDs generated for legacy bare-target links
# until the one-time operation-log migration assigns stable UUIDs.
_LEGACY_LINK_UUID_NAMESPACE = uuid_module.UUID("0194a1b2-3c4d-5e6f-7a8b-9c0d1e2f3a4b")


class NodeLinkInstance:
    """A single inline link instance extracted from an AST."""

    def __init__(
        self,
        link_uuid: str,
        target_uuid: str,
        ref_type: str,
        label: str | None,
    ) -> None:
        self.link_uuid = link_uuid
        self.target_uuid = target_uuid
        self.ref_type = ref_type
        self.label = label


def _link_uuid_for_legacy_target(source_id: str, target_id: str) -> str:
    """Return a deterministic link UUID for a legacy bare-target link.

    The one-time migration in ``app/db/migrations/normalize_node_link_uuids.py``
    rewrites operation-log payloads to include stable link UUIDs. Until it runs,
    derived-state rebuilds must still produce deterministic node_link rows so
    counts and backlinks remain stable across rebuilds.
    """
    return str(uuid_module.uuid5(_LEGACY_LINK_UUID_NAMESPACE, f"{source_id}:{target_id}"))


def extract_node_link_instances(
    content: list[dict[str, Any]], source_id: str
) -> list[NodeLinkInstance]:
    """Return all inline link instances from the content AST.

    Supports ``node_link`` pills, legacy ``ref`` nodes, and raw ``[[uuid]]`` text.
    Legacy bare ``targetUuid`` identifiers are assigned a deterministic link UUID.
    """
    instances: list[NodeLinkInstance] = []
    seen_legacy_targets: set[str] = set()

    def _visit(node: Any) -> None:
        if not isinstance(node, dict):
            return
        ctype = node.get("type")
        if ctype == "node_link" and node.get("link_id"):
            link_id = str(node["link_id"])
            parts = link_id.split(":", 1)
            target_id = parts[0]
            link_uuid = parts[1] if len(parts) > 1 else _link_uuid_for_legacy_target(source_id, target_id)
            if target_id:
                instances.append(
                    NodeLinkInstance(
                        link_uuid=link_uuid,
                        target_uuid=target_id,
                        ref_type=node.get("ref_type", "node"),
                        label=node.get("label"),
                    )
                )
        elif ctype == "ref" and node.get("targetId"):
            target_id = str(node["targetId"])
            link_uuid = _link_uuid_for_legacy_target(source_id, target_id)
            if target_id not in seen_legacy_targets:
                seen_legacy_targets.add(target_id)
                instances.append(
                    NodeLinkInstance(
                        link_uuid=link_uuid,
                        target_uuid=target_id,
                        ref_type="node",
                        label=node.get("label"),
                    )
                )
        elif ctype == "text" and isinstance(node.get("text"), str):
            text = node["text"]
            for match in re.finditer(r"\[\[([^\]]+)\]\]", text):
                target_id = match.group(1)
                link_uuid = _link_uuid_for_legacy_target(source_id, target_id)
                if target_id not in seen_legacy_targets:
                    seen_legacy_targets.add(target_id)
                    instances.append(
                        NodeLinkInstance(
                            link_uuid=link_uuid,
                            target_uuid=target_id,
                            ref_type="node",
                            label=None,
                        )
                    )
        children = node.get("children")
        if isinstance(children, list):
            for child in children:
                _visit(child)

    for child in content:
        _visit(child)
    return instances


def rebuild_node_links_for_node(conn: sqlite3.Connection, op: Operation) -> None:
    """Synchronise ``node_link`` rows for ``op.payload.nodeId``."""
    node_id = op.payload["nodeId"]
    workspace_id = op.envelope.workspace_id
    row = conn.execute("SELECT content FROM node WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        return
    content = json.loads(row[0])
    desired = extract_node_link_instances(content, node_id)
    desired_ids = {link.link_uuid for link in desired}

    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    for link in desired:
        conn.execute(
            """
            INSERT INTO node_link (
                id, workspace_id, source_id, target_id, type, label,
                click_count, last_navigated_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_id = excluded.source_id,
                target_id = excluded.target_id,
                type = excluded.type,
                label = excluded.label,
                updated_at = excluded.updated_at
            """,
            (
                link.link_uuid,
                workspace_id,
                node_id,
                link.target_uuid,
                link.ref_type,
                link.label,
                0,
                None,
                ts,
                ts,
            ),
        )

    for stale_id in _existing_node_link_ids(conn, node_id) - desired_ids:
        conn.execute("DELETE FROM node_link WHERE id = ?", (stale_id,))


def _existing_node_link_ids(conn: sqlite3.Connection, source_id: str) -> set[str]:
    rows = conn.execute("SELECT id FROM node_link WHERE source_id = ?", (source_id,)).fetchall()
    return {row["id"] for row in rows}


def rebuild_edges_for_node(conn: sqlite3.Connection, op: Operation) -> None:
    """Synchronise ``edge`` rows of type ``reference`` for ``op.payload.nodeId``.

    ``edge`` is a deduplicated graph projection derived from ``node_link``.
    It exists for backwards compatibility until all callers migrate to
    ``node_link``.
    """
    node_id = op.payload["nodeId"]
    workspace_id = op.envelope.workspace_id
    rebuild_node_links_for_node(conn, op)

    desired_edges: dict[tuple[str, str], str | None] = {}
    for row in conn.execute(
        "SELECT target_id, label FROM node_link WHERE source_id = ?",
        (node_id,),
    ).fetchall():
        key = (node_id, row["target_id"])
        if key not in desired_edges:
            desired_edges[key] = row["label"]

    existing = conn.execute(
        "SELECT id, target_id, metadata FROM edge WHERE source_id = ? AND type = ?",
        (node_id, "reference"),
    ).fetchall()
    existing_targets = {row["target_id"]: row for row in existing}

    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    for (_, target_id), label in desired_edges.items():
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
                json.dumps({"label": label}),
                ts,
            ),
        )

    desired_target_ids = {target_id for (_, target_id) in desired_edges}
    for target_id, row in existing_targets.items():
        if target_id not in desired_target_ids:
            conn.execute("DELETE FROM edge WHERE id = ?", (row["id"],))
