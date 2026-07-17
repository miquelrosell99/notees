"""Migrate inline links and property references from the legacy schema.

Inline references stored in ``node_link`` (with ``property_id IS NULL``) are
rewritten into the source node's content AST as ``node_link`` nodes carrying
mapped target UUIDs and optional labels. Property relation targets are mapped
through ``id_map`` so that property migration (Phase 2.B2) can emit correct
``property.set`` operations.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from typing import Any

import asyncpg

from app.core.migration.nodes import MigrationContext
from app.core.migration.writer import OperationWriter
from app.core.operation import create_operation
from app.core.uuid import uuidv7

# Legacy inline reference syntax: [[nodeId]] or [[nodeId:linkUuid]] and
# ((block-uuid)) / ((block-uuid:linkUuid)).
_INLINE_REF_RE = re.compile(
    r"\[\[([^\]]+)\]\]|\(\(([^)]+)\)\)"
)


async def fetch_inline_links(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Return inline node_link rows for a workspace ordered by source, position.

    Inline links are those not attached to a property (``property_id IS NULL``).
    """
    query = """
        SELECT id, uuid, source_id, target_id, property_id, position,
               is_tag, is_inline_class, is_embed, name
        FROM node_link
        WHERE workspace_id = $1 AND property_id IS NULL
        ORDER BY source_id, position
    """
    return await conn.fetch(query, workspace_int_id)


async def fetch_node_names(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> dict[int, str]:
    """Return a mapping from live node integer id to raw name/content."""
    rows = await conn.fetch(
        """
        SELECT id, name
        FROM node
        WHERE workspace_id = $1 AND is_deleted = FALSE
        """,
        workspace_int_id,
    )
    return {row["id"]: row["name"] or "" for row in rows}


async def fetch_property_relations(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Return property_value_relation rows that reference other nodes.

    This covers ``node`` and ``text`` type property relations. Date/image
    relations are excluded because they reference non-node entities.
    """
    query = """
        SELECT pvr.id, pvr.node_id, pvr.property_id, pvr.target_id, p.type
        FROM property_value_relation pvr
        JOIN property p ON pvr.property_id = p.id
        WHERE pvr.node_id IN (
            SELECT id FROM node WHERE workspace_id = $1 AND is_deleted = FALSE
        )
          AND p.type IN ('node', 'text')
        ORDER BY pvr.node_id, pvr.property_id, pvr.target_id
    """
    return await conn.fetch(query, workspace_int_id)


def _parse_ast(content: str) -> list[dict[str, Any]] | None:
    """Parse a raw content string as AST JSON, returning None if invalid."""
    if not content or not content.strip():
        return None
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, list):
        return None
    if parsed and (not isinstance(parsed[0], dict) or "type" not in parsed[0]):
        return None
    return parsed


def _ref_type_from_link(link: asyncpg.Record) -> str:
    """Map a node_link row to an AST ref_type value."""
    if link.get("is_inline_class"):
        return "class"
    if link.get("is_embed"):
        return "embed"
    return "node"


def _map_link_id(link_id: str, id_map: dict[int, str]) -> str:
    """Rewrite a link_id so its target portion uses a migrated UUID.

    ``link_id`` may be ``target`` or ``target:linkUuid``. The target portion is
    either a legacy integer id (mapped through ``id_map``) or an existing UUID
    (preserved as-is).
    """
    if not link_id:
        return link_id
    parts = link_id.split(":", 1)
    target = parts[0]
    suffix = parts[1] if len(parts) > 1 else ""

    if target.isdigit():
        mapped = id_map.get(int(target))
        if mapped is None:
            mapped = uuidv7()
            id_map[int(target)] = mapped
    else:
        mapped = target

    if suffix:
        return f"{mapped}:{suffix}"
    return mapped


def _rewrite_ast_links(
    ast: list[dict[str, Any]],
    id_map: dict[int, str],
) -> list[dict[str, Any]]:
    """Recursively rewrite ``node_link`` AST nodes to use mapped UUIDs."""
    result: list[dict[str, Any]] = []
    for node in ast:
        if not isinstance(node, dict):
            continue
        node_type = node.get("type")
        if node_type == "node_link":
            new_node = dict(node)
            new_node["link_id"] = _map_link_id(
                str(node.get("link_id", "")), id_map
            )
            result.append(new_node)
        elif "children" in node and isinstance(node["children"], list):
            new_node = dict(node)
            new_node["children"] = _rewrite_ast_links(
                node["children"], id_map
            )
            result.append(new_node)
        else:
            result.append(node)
    return result


def _text_to_link_ast(
    text: str,
    links: list[asyncpg.Record],
    id_map: dict[int, str],
) -> list[dict[str, Any]]:
    """Convert plain text with [[id]] / ((uuid)) refs into inline AST nodes.

    Links without a matching node_link record are left as plain text.
    """
    if not text:
        return []

    # Build a quick lookup by legacy integer id and by raw reference text.
    by_target_id: dict[int, asyncpg.Record] = {}
    by_text: dict[str, asyncpg.Record] = {}
    for link in links:
        by_target_id[link["target_id"]] = link
        if link.get("name"):
            by_text[link["name"]] = link

    children: list[dict[str, Any]] = []
    position = 0

    for match in _INLINE_REF_RE.finditer(text):
        start, end = match.span()
        if start > position:
            children.append({"type": "text", "text": text[position:start]})

        ref_text = match.group(1) or match.group(2) or ""
        link_record: asyncpg.Record | None = None

        # [[integer-id]] syntax.
        if ref_text.isdigit():
            link_record = by_target_id.get(int(ref_text))
        # [[uuid]] or ((uuid)) syntax, optionally with :linkUuid suffix.
        else:
            base = ref_text.split(":", 1)[0]
            for link in links:
                mapped_target = id_map.get(link["target_id"], "")
                if mapped_target and mapped_target == base:
                    link_record = link
                    break
            if link_record is None:
                link_record = by_text.get(ref_text)

        if link_record is not None:
            target_uuid = id_map.get(link_record["target_id"])
            if target_uuid is None:
                target_uuid = uuidv7()
                id_map[link_record["target_id"]] = target_uuid
            label = link_record.get("name")
            children.append(
                {
                    "type": "node_link",
                    "link_id": target_uuid,
                    "ref_type": _ref_type_from_link(link_record),
                    "label": label,
                }
            )
        else:
            children.append({"type": "text", "text": match.group(0)})

        position = end

    if position < len(text):
        children.append({"type": "text", "text": text[position:]})

    return children


def _build_content_ast(
    raw_name: str,
    links: list[asyncpg.Record],
    id_map: dict[int, str],
) -> list[dict[str, Any]]:
    """Build the ideal content AST for a source node given its legacy name.

    If the raw name is already AST JSON, its ``node_link`` nodes are rewritten
    to use mapped UUIDs. Otherwise the name is treated as plain text and inline
    references are converted to ``node_link`` nodes.
    """
    ast = _parse_ast(raw_name)
    if ast is not None:
        return _rewrite_ast_links(ast, id_map)

    children = _text_to_link_ast(raw_name, links, id_map)
    if not children:
        return []
    return [{"type": "paragraph", "children": children}]


def _group_links_by_source(
    links: list[asyncpg.Record],
) -> dict[int, list[asyncpg.Record]]:
    """Group inline link records by their source node integer id."""
    grouped: dict[int, list[asyncpg.Record]] = defaultdict(list)
    for link in links:
        grouped[link["source_id"]].append(link)
    return grouped


def _emit_update_content_ops(
    ctx: MigrationContext,
    names: dict[int, str],
    links_by_source: dict[int, list[asyncpg.Record]],
) -> list[Any]:
    """Generate ``node.updateContent`` operations for nodes with inline refs."""
    operations: list[Any] = []
    for source_int_id, raw_name in names.items():
        links = links_by_source.get(source_int_id, [])
        if not links:
            continue

        source_uuid = ctx.id_map.get(source_int_id)
        if source_uuid is None:
            source_uuid = uuidv7()
            ctx.id_map[source_int_id] = source_uuid

        ast = _build_content_ast(raw_name, links, ctx.id_map)
        if not ast:
            continue

        operations.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [source_uuid],
                    "op_type": "node.updateContent",
                },
                payload={
                    "nodeId": source_uuid,
                    "crdtUpdate": ast,
                },
            )
        )
    return operations


def map_relation_targets(
    relations: list[asyncpg.Record],
    id_map: dict[int, str],
) -> dict[tuple[int, int, int], str]:
    """Map property relation target integer ids to migrated UUIDs.

    Returns a mapping ``(node_id, property_id, target_id) -> target_uuid`` so
    property migration can write relation ``property.set`` operations using the
    same UUID namespace as nodes and inline links.
    """
    result: dict[tuple[int, int, int], str] = {}
    for row in relations:
        target_int_id = row["target_id"]
        target_uuid = id_map.get(target_int_id)
        if target_uuid is None:
            target_uuid = uuidv7()
            id_map[target_int_id] = target_uuid
        result[(row["node_id"], row["property_id"], target_int_id)] = target_uuid
    return result


async def migrate_links_for_workspace(
    conn: asyncpg.Connection,
    workspace_int_id: int,
    ctx: MigrationContext,
    writer: OperationWriter,
) -> int:
    """Migrate one workspace's inline links and relation references.

    Args:
        conn: Asyncpg connection to the source PostgreSQL database.
        workspace_int_id: Legacy integer id of the workspace to migrate.
        ctx: Shared migration context (id_map, HLC clock).
        writer: Operation sink (SQLite file or in-memory collector).

    Returns:
        Number of operations written.
    """
    inline_links = await fetch_inline_links(conn, workspace_int_id)
    names = await fetch_node_names(conn, workspace_int_id)
    links_by_source = _group_links_by_source(inline_links)

    operations = _emit_update_content_ops(ctx, names, links_by_source)

    for operation in operations:
        writer.write_operation(operation)

    return len(operations)


async def map_property_relation_targets(
    conn: asyncpg.Connection,
    workspace_int_id: int,
    ctx: MigrationContext,
) -> dict[tuple[int, int, int], str]:
    """Return migrated UUIDs for all property relation targets.

    This helper is consumed by property migration (Phase 2.B2) to ensure
    relation targets use the shared UUID namespace.
    """
    relations = await fetch_property_relations(conn, workspace_int_id)
    return map_relation_targets(relations, ctx.id_map)
