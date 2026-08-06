"""Migration: assign stable link-instance UUIDs to legacy bare-target links.

Scans the relay operation log for ``node.create`` and ``node.updateContent``
operations whose AST contains ``node_link`` nodes with bare target UUIDs
(``link_id`` without a ``:`` separator). Each bare target gets a deterministic
link UUID so the AST identifier becomes ``targetUuid:linkUuid``.

The deterministic UUID is generated with the same namespace and algorithm used
by the backend and frontend derived-state appliers, so counts and backlinks stay
stable across rebuilds.
"""

from __future__ import annotations

import json
import uuid as uuid_module
from typing import Any

import asyncpg

_LEGACY_LINK_UUID_NAMESPACE = uuid_module.UUID(
    "0194a1b2-3c4d-5e6f-7a8b-9c0d1e2f3a4b"
)


def _link_uuid_for_legacy_target(source_id: str, target_id: str) -> str:
    return str(
        uuid_module.uuid5(
            _LEGACY_LINK_UUID_NAMESPACE, f"{source_id}:{target_id}"
        )
    )


def _is_uuid(value: str) -> bool:
    try:
        uuid_module.UUID(value)
        return True
    except (ValueError, TypeError):
        return False


def _walk_ast(
    nodes: list[Any],
    source_id: str,
) -> tuple[list[Any], bool]:
    """Walk AST and assign link UUIDs to bare-target node_link nodes."""
    changed = False
    new_nodes: list[Any] = []

    for node in nodes:
        if not isinstance(node, dict):
            new_nodes.append(node)
            continue

        if node.get("type") == "node_link" and node.get("link_id"):
            link_id = str(node["link_id"])
            if ":" not in link_id:
                target_id = link_id
                if _is_uuid(target_id):
                    link_uuid = _link_uuid_for_legacy_target(source_id, target_id)
                    new_nodes.append({**node, "link_id": f"{target_id}:{link_uuid}"})
                    changed = True
                    continue

        if "children" in node and isinstance(node["children"], list):
            new_children, child_changed = _walk_ast(node["children"], source_id)
            if child_changed:
                new_nodes.append({**node, "children": new_children})
                changed = True
                continue

        new_nodes.append(node)

    return new_nodes, changed


def _normalize_payload(payload: dict[str, Any], source_id: str) -> tuple[dict[str, Any], bool]:
    """Normalize link_ids inside a single operation payload."""
    changed = False
    new_payload = dict(payload)

    content_keys = ("initialContent", "content", "crdtUpdate")
    for key in content_keys:
        raw = new_payload.get(key)
        if raw is None:
            continue
        if isinstance(raw, dict):
            ast = [raw]
        elif isinstance(raw, list):
            ast = raw
        else:
            continue

        if not ast or not isinstance(ast[0], dict):
            continue

        new_ast, ast_changed = _walk_ast(ast, source_id)
        if ast_changed:
            # Preserve original wrapping (list vs single dict).
            if isinstance(raw, dict):
                new_payload[key] = new_ast[0] if new_ast else raw
            else:
                new_payload[key] = new_ast
            changed = True

    return new_payload, changed


async def run(conn: asyncpg.Connection) -> int:
    """Run the migration and return the number of rewritten operations."""
    rows = await conn.fetch(
        """
        SELECT id, op_type, payload
        FROM relay_envelope
        WHERE op_type IN ('node.create', 'node.updateContent')
        ORDER BY workspace_id, physical, logical, id
        """
    )

    updated = 0
    for row in rows:
        payload = row["payload"]
        if not isinstance(payload, dict):
            continue

        source_id = payload.get("nodeId")
        if not source_id:
            continue

        new_payload, changed = _normalize_payload(payload, source_id)
        if changed:
            await conn.execute(
                "UPDATE relay_envelope SET payload = $1 WHERE id = $2",
                json.dumps(new_payload),
                row["id"],
            )
            updated += 1

    return updated
