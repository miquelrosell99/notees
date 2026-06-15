"""Migration: normalize inline class link identifiers to lowercase UUIDs.

Scans all active nodes' AST content for node_link entries with ref_type='class'
and ensures the target identifier in link_id is a lowercase UUID.

- Uppercase UUIDs are lowercased.
- Legacy numeric node IDs are replaced with the node's UUID.
- Malformed/empty identifiers are converted to broken_link nodes.
"""

from __future__ import annotations

import json
import re
import uuid as uuid_module
from datetime import UTC, datetime
from typing import Any

import asyncpg

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _is_uuid(value: str) -> bool:
    return bool(_UUID_RE.match(value))


def _to_broken_link(node: dict[str, Any]) -> dict[str, Any]:
    """Convert a malformed inline class link to a broken_link."""
    broken: dict[str, Any] = {"type": "broken_link", "link_id": node.get("link_id", "")}
    if node.get("label"):
        broken["label"] = node["label"]
    return broken


def _normalize_uuid_link(node: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize a node_link whose identifier is already a UUID.

    Returns the normalized node if changed, or None if no change is needed.
    """
    link_id = str(node.get("link_id", ""))
    parts = link_id.split(":", 1)
    node_identifier = parts[0]
    link_uuid = parts[1] if len(parts) > 1 else None

    if not node_identifier or not _is_uuid(node_identifier):
        return None

    normalized_uuid = node_identifier.lower()
    if normalized_uuid == node_identifier and link_uuid:
        return None

    new_link_id = f"{normalized_uuid}:{link_uuid}" if link_uuid else normalized_uuid
    return {**node, "link_id": new_link_id}


def _walk(
    nodes: list[Any],
    numeric_ids: set[int],
) -> tuple[list[Any], bool]:
    """Walk AST, normalize UUIDs in place, and collect legacy numeric IDs.

    Returns the transformed AST and a flag indicating whether any node was
    changed (including UUID normalization or numeric placeholder insertion).
    """
    changed = False
    new_nodes: list[Any] = []

    for node in nodes:
        if not isinstance(node, dict):
            new_nodes.append(node)
            continue

        if node.get("type") == "node_link" and node.get("ref_type") == "class":
            link_id = str(node.get("link_id", ""))
            parts = link_id.split(":", 1)
            node_identifier = parts[0]

            if not node_identifier:
                new_nodes.append(_to_broken_link(node))
                changed = True
                continue

            normalized = _normalize_uuid_link(node)
            if normalized is not None:
                new_nodes.append(normalized)
                changed = True
                continue

            if node_identifier.isdigit():
                numeric_ids.add(int(node_identifier))
                new_nodes.append({"__numeric_placeholder__": True, "node": node})
                changed = True
                continue

            # Unrecognized identifier shape: treat as broken.
            new_nodes.append(_to_broken_link(node))
            changed = True
            continue

        if "children" in node:
            new_children, child_changed = _walk(node["children"], numeric_ids)
            new_nodes.append({**node, "children": new_children})
            changed = changed or child_changed
        else:
            new_nodes.append(node)

    return new_nodes, changed


def _resolve_numeric_ids(
    nodes: list[Any],
    id_to_uuid: dict[int, str],
) -> tuple[list[Any], bool]:
    """Replace numeric placeholders with UUID-based links or broken_link nodes."""
    changed = False
    new_nodes: list[Any] = []

    for node in nodes:
        if not isinstance(node, dict):
            new_nodes.append(node)
            continue

        if node.get("__numeric_placeholder__"):
            original = node["node"]
            numeric_id = int(original["link_id"].split(":", 1)[0])
            uuid = id_to_uuid.get(numeric_id)
            if uuid:
                parts = str(original.get("link_id", "")).split(":", 1)
                link_uuid = parts[1] if len(parts) > 1 else str(uuid_module.uuid4())
                new_nodes.append({**original, "link_id": f"{uuid}:{link_uuid}"})
            else:
                new_nodes.append(_to_broken_link(original))
            changed = True
            continue

        if "children" in node:
            new_children, child_changed = _resolve_numeric_ids(node["children"], id_to_uuid)
            new_nodes.append({**node, "children": new_children})
            changed = changed or child_changed
        else:
            new_nodes.append(node)

    return new_nodes, changed


async def run(conn: asyncpg.Connection) -> None:
    """Run the migration."""
    rows = await conn.fetch(
        """
        SELECT id, name
        FROM node
        WHERE active = TRUE
          AND name::text LIKE '%%ref_type%%class%%'
        ORDER BY id
        """
    )

    pending_updates: list[tuple[int, list[Any], list[Any]]] = []
    all_numeric_ids: set[int] = set()

    for row in rows:
        content = row["name"]
        if not content:
            continue
        try:
            ast = json.loads(content)
            if not isinstance(ast, list):
                continue
            if ast and (not isinstance(ast[0], dict) or "type" not in ast[0]):
                continue
        except (json.JSONDecodeError, TypeError):
            continue

        new_ast, changed = _walk(ast, all_numeric_ids)
        if changed:
            pending_updates.append((row["id"], ast, new_ast))

    if not pending_updates:
        return

    id_to_uuid: dict[int, str] = {}
    if all_numeric_ids:
        resolved = await conn.fetch(
            "SELECT id, uuid FROM node WHERE id = ANY($1::integer[]) AND active = TRUE",
            list(all_numeric_ids),
        )
        id_to_uuid = {row["id"]: str(row["uuid"]).lower() for row in resolved}

    for node_id, original_ast, new_ast in pending_updates:
        final_ast, _ = _resolve_numeric_ids(new_ast, id_to_uuid)
        if final_ast != original_ast:
            new_content = json.dumps(final_ast, ensure_ascii=False)
            await conn.execute(
                """
                UPDATE node
                SET name = $1, write_date = $2
                WHERE id = $3
                """,
                new_content,
                datetime.now(UTC),
                node_id,
            )
