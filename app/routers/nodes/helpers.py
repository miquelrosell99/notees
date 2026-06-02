"""Helper functions for the Nodes API."""

import json
from typing import Any

from ...db.connection import acquire_connection, get_pool
from ...domain.entities import Node
from ...domain.repositories import (
    PostgresLinkRepository,
    PostgresNodeRepository,
    PostgresPropertyRepository,
)
from ...domain.services import LinkParsingService, NodeService
from ...logging_config import get_logger
from ...models import User
from .models import NodeResponse

logger = get_logger(__name__)


def _extract_property_value(val):
    """Extract a single typed value from a property value row."""
    if hasattr(val, "target_id"):
        return val.target_id
    elif hasattr(val, "value_integer"):
        if val.value_text is not None:
            return val.value_text
        elif val.value_integer is not None:
            return val.value_integer
        elif val.value_float is not None:
            return val.value_float
        elif val.value_boolean is not None:
            return val.value_boolean
    elif hasattr(val, "selection_line_id"):
        return val.selection_line_id
    return None


def extract_properties_dict(all_prop_values: dict[int, dict[str, Any]]) -> dict[str, Any]:
    """Convert raw property values from the repository into a JSON-serializable dict.

    For multi-value properties, returns an array of values (even if empty or single value).
    For single-value properties, returns a single value.
    """
    props_dict: dict[str, Any] = {}

    for prop_id, prop_data in all_prop_values.items():
        prop = prop_data["property"]
        values = prop_data["values"]
        if values:
            if prop.is_multi:
                # Multi-value: always return array, deduplicated to avoid import artifacts
                seen: set = set()
                unique_values: list = []
                for v in values:
                    extracted = _extract_property_value(v)
                    if extracted is not None and extracted not in seen:
                        seen.add(extracted)
                        unique_values.append(extracted)
                props_dict[str(prop_id)] = unique_values
            else:
                # Single-value: return scalar
                extracted = _extract_property_value(values[0])
                if extracted is not None:
                    props_dict[str(prop_id)] = extracted
                else:
                    props_dict[str(prop_id)] = None
        else:
            # No values yet - for multi, return empty array; for single, return null
            props_dict[str(prop_id)] = [] if prop.is_multi else None

    return props_dict


def _node_to_response(
    node: Node,
    tags: list[int] | None = None,
    classes: list[int] | None = None,
    comment_count: int = 0,
    backlink_count: int = 0,
    aliases: list[int] | None = None,
    has_children: bool = False,
    extends: list[int] | None = None,
) -> NodeResponse:
    """Convert domain Node to API response.

    The is_class, is_page, is_daily, etc. flags are stored on the node and
    automatically updated when classes change (via add_class/remove_class).
    """
    return NodeResponse(
        id=node.id or 0,
        uuid=node.uuid,
        name=node.name or "",
        icon=node.icon,
        color=node.color,
        parent_id=node.parent_id,
        page_id=node.page_id,
        sequence=node.sequence,
        collapsed=node.collapsed,
        active=node.active,
        is_page=node.is_page,
        is_class=node.is_class,
        is_daily=node.is_day,
        is_monthly=node.is_month,
        is_yearly=node.is_year,
        is_comment=node.is_comment,
        parent_locked=node.parent_locked,
        visibility=node.visibility,
        create_date=node.create_date,
        write_date=node.write_date,
        open_date=node.open_date,
        display_name=node.display_name,
        tags=tags or [],
        classes=classes or [],
        comment_count=comment_count,
        backlink_count=backlink_count,
        classes_path=json.loads(node.classes_path) if isinstance(node.classes_path, str) else (node.classes_path or []),
        aliased_id=node.aliased_id,
        aliases=aliases or [],
        has_children=has_children,
        extends=extends or [],
    )


def _build_children_response(
    children: list[Node], class_ids_map: dict[int, list[int]] | None = None
) -> list[NodeResponse]:
    """Build a nested NodeResponse list from a flat list of children.

    Assumes children are ordered by sequence and reconstructs the hierarchy
    based on parent_id relationships.

    Args:
        children: Flat list of child nodes
        class_ids_map: Optional mapping of node_id -> list of class_ids
    """
    if not children:
        return []

    class_ids_map = class_ids_map or {}

    # Build lookup maps
    node_map: dict[int, NodeResponse] = {}
    root_children: list[NodeResponse] = []

    # First pass: convert all nodes to responses
    for node in children:
        classes = class_ids_map.get(node.id, []) if node.id else []
        response = _node_to_response(node, classes=classes)
        response.children = []
        if node.id:
            node_map[node.id] = response

    # Second pass: build hierarchy
    for node in children:
        if not node.id:
            continue
        response = node_map[node.id]
        if node.parent_id and node.parent_id in node_map:
            parent = node_map[node.parent_id]
            if parent.children is not None:
                parent.children.append(response)
        else:
            root_children.append(response)

    return root_children


async def _get_descendants(node_repo, parent_id: int) -> list[Node]:
    """Get all descendants of a node using recursive CTE.

    Returns a flat list of all descendants, ordered by depth then sequence.
    Uses a recursive CTE on the adjacency list (parent_id).
    """
    # Use the repository's get_descendants method if available
    if hasattr(node_repo, "get_descendants"):
        descendant_ids = await node_repo.get_descendants(parent_id, include_self=False)
        # Batch-fetch all descendants in a single query instead of N individual calls
        if descendant_ids:
            return await node_repo.get_by_ids(descendant_ids)
        return []

    # Fallback to manual traversal if method not available
    all_descendants: list[Node] = []
    to_process = [parent_id]

    while to_process:
        current_id = to_process.pop(0)
        children = await node_repo.get_children(current_id)
        all_descendants.extend(children)
        for child in children:
            if child.id:
                to_process.append(child.id)

    return all_descendants


async def _get_class_ids(service: NodeService, node_id: int) -> list[int]:
    """Helper to get class IDs for a node."""
    classes = await service.get_node_classes(node_id)
    return [c.id for c in classes if c.id]


async def _get_tag_ids(pool, workspace_id: int, node_id: int) -> list[int]:
    """Helper to get tag IDs for a node (from node_link with is_tag=1)."""
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            """
            SELECT target_id FROM node_link
            WHERE source_id = $1 AND is_tag = TRUE AND property_id IS NULL
            ORDER BY position
        """,
            node_id,
        )
        return [row["target_id"] for row in rows]


async def _get_alias_ids(pool, workspace_id: int, node_id: int) -> list[int]:
    """Helper to get alias IDs for a node (nodes that have aliased_id = node_id)."""
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            """
            SELECT id FROM node
            WHERE aliased_id = $1 AND workspace_id = $2
              AND active = TRUE AND (is_deleted = FALSE OR is_deleted IS NULL)
            ORDER BY name
        """,
            node_id,
            workspace_id,
        )
        return [row["id"] for row in rows]


async def _get_class_ids_batch(pool, workspace_id: int, node_ids: list[int], *, conn=None) -> dict[int, list[int]]:
    """Efficiently fetch class_ids directly from node table.

    Returns a dict mapping node_id -> list of class_ids.
    If conn is provided, uses that connection instead of acquiring from pool.
    """
    if not node_ids:
        return {}

    async def _fetch(c):
        rows = await c.fetch(
            """
            SELECT id, class_ids
            FROM node
            WHERE id = ANY($1) AND workspace_id = $2
        """,
            node_ids,
            workspace_id,
        )
        return {row["id"]: list(row["class_ids"] or []) for row in rows}

    if conn is not None:
        return await _fetch(conn)

    async with acquire_connection(pool) as c:
        return await _fetch(c)


async def _get_extends_batch(pool, workspace_id: int, node_ids: list[int]) -> dict[int, list[int]]:
    """Batch-fetch class extends (parent class IDs) for a set of class nodes.

    Returns a dict mapping target_id (child class) -> list of source_ids (parent classes)
    in sequence order.
    """
    if not node_ids:
        return {}

    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            """
            SELECT ce.target_id, ce.source_id
            FROM class_extend ce
            JOIN node n ON n.id = ce.source_id
            WHERE ce.target_id = ANY($1)
              AND n.workspace_id = $2
              AND n.active = TRUE
            ORDER BY ce.target_id, ce.sequence, ce.id
        """,
            node_ids,
            workspace_id,
        )

        result: dict[int, list[int]] = {}
        for row in rows:
            result.setdefault(row["target_id"], []).append(row["source_id"])
        return result


async def _get_related_ids_batch(
    pool,
    workspace_id: int,
    node_ids: list[int],
    relation_type: str,
) -> dict[int, list[int]]:
    """Generic batch-fetch for IDs related to a set of source node IDs.

    Args:
        pool: asyncpg connection pool
        workspace_id: Current workspace (used for alias lookups)
        node_ids: Source node IDs to look up relations for
        relation_type: One of 'tags', 'aliases', 'classes'

    Returns:
        Dict mapping source node_id -> list of related IDs.

    Note:
        'classes' uses a dedicated path because the data lives in an array
        column rather than a join table, and supports an optional ``conn``
        override.  Prefer calling ``_get_class_ids_batch`` directly when you
        already hold a connection.
    """
    if not node_ids:
        return {}

    result: dict[int, list[int]] = {nid: [] for nid in node_ids}

    if relation_type == "tags":
        async with acquire_connection(pool) as conn:
            rows = await conn.fetch(
                """
                SELECT source_id, target_id
                FROM node_link
                WHERE source_id = ANY($1) AND is_tag = TRUE AND property_id IS NULL
                ORDER BY source_id, position
            """,
                node_ids,
            )
        for row in rows:
            source_id = row["source_id"]
            if source_id in result and row["target_id"]:
                result[source_id].append(row["target_id"])

    elif relation_type == "aliases":
        async with acquire_connection(pool) as conn:
            rows = await conn.fetch(
                """
                SELECT aliased_id, id
                FROM node
                WHERE aliased_id = ANY($1) AND workspace_id = $2
                  AND active = TRUE AND (is_deleted = FALSE OR is_deleted IS NULL)
                ORDER BY aliased_id, name
            """,
                node_ids,
                workspace_id,
            )
        for row in rows:
            aliased_id = row["aliased_id"]
            if aliased_id in result:
                result[aliased_id].append(row["id"])

    elif relation_type == "classes":
        async with acquire_connection(pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, class_ids
                FROM node
                WHERE id = ANY($1) AND workspace_id = $2
            """,
                node_ids,
                workspace_id,
            )
        for row in rows:
            result[row["id"]] = list(row["class_ids"] or [])

    else:
        raise ValueError(f"Unknown relation_type: {relation_type!r}")

    return result


async def _get_effective_class_ids_batch(
    pool, workspace_id: int, node_ids: list[int], user_id: int
) -> dict[int, list[int]]:
    """Fetch class_ids for multiple nodes including inherited classes from extends.

    For each node:
    - Gets explicit classes from the class_ids column
    - For each explicit class, gets all classes it extends (inheritance chain)
    - Returns combined list (explicit + inherited), with explicit classes first

    Returns a dict mapping node_id -> list of class_ids (explicit + inherited).
    """
    from ...domain.repositories import PostgresPropertyRepository
    from ...domain.services.class_extension_service import ClassExtensionService

    # First get explicit classes
    explicit_classes = await _get_class_ids_batch(pool, workspace_id, node_ids)

    if not explicit_classes:
        return {nid: [] for nid in node_ids}

    # For each unique class, get its inheritance chain
    all_explicit_class_ids = set()
    for class_list in explicit_classes.values():
        all_explicit_class_ids.update(class_list)

    if not all_explicit_class_ids:
        return explicit_classes

    property_repo = PostgresPropertyRepository(pool, workspace_id, user_id)
    from ...domain.repositories.postgres_class_extend import PostgresClassExtendRepository

    class_extend_repo = PostgresClassExtendRepository(pool, workspace_id, user_id)
    extension_service = ClassExtensionService(pool, workspace_id, property_repo, class_extend_repo)

    # Cache for class -> extended classes
    extends_cache: dict[int, list[int]] = {}

    for class_id in all_explicit_class_ids:
        try:
            # get_all_extended_classes returns [class_id, parent1, parent2, ...]
            extended = await extension_service.get_all_extended_classes(class_id)
            # Store only the parents (skip the first element which is class_id itself)
            extends_cache[class_id] = extended[1:] if len(extended) > 1 else []
        except Exception:
            # If there's an error (e.g., circular reference), just skip inheritance for this class
            extends_cache[class_id] = []

    # Build effective class lists
    result: dict[int, list[int]] = {}
    for node_id in node_ids:
        explicit = explicit_classes.get(node_id, [])
        effective = list(explicit)  # Start with explicit classes

        # Add inherited classes
        for class_id in explicit:
            inherited = extends_cache.get(class_id, [])
            for inherited_class in inherited:
                if inherited_class not in effective:
                    effective.append(inherited_class)

        result[node_id] = effective

    return result


async def _build_children_tree(service, nodes: list[Any], class_ids_map: dict[int, list[int]]) -> list[Any]:
    """Build a tree with children for each node.

    Fetches all descendants for each node and builds a nested structure.
    Uses a single batched recursive CTE for all root nodes to avoid N+1 queries.
    Used by list_nodes when include_children=True.
    """
    # Collect root node IDs
    root_ids = []
    root_map: dict[int, Any] = {}
    for node_response in nodes:
        node_id = node_response.id if hasattr(node_response, "id") else node_response.get("id")
        if node_id:
            root_ids.append(node_id)
            root_map[node_id] = node_response

    if not root_ids:
        return nodes

    # Single batched CTE: fetch all descendants for all root nodes at once
    descendants_batch = await service.get_node_descendants_batch(root_ids)

    # Collect all descendant IDs for class_ids batch fetch
    all_descendant_ids: list[int] = []
    for desc_ids in descendants_batch.values():
        all_descendant_ids.extend(desc_ids)

    if all_descendant_ids:
        desc_class_ids = await _get_class_ids_batch(service.pool, service.workspace_id or 0, all_descendant_ids)
        class_ids_map.update(desc_class_ids)

    # Fetch all descendant nodes in one query
    all_descendant_nodes = await service.get_nodes_by_ids(all_descendant_ids) if all_descendant_ids else []
    node_by_id = {n.id: n for n in all_descendant_nodes}

    # Build children for each root
    result = []
    for node_response in nodes:
        node_id = node_response.id if hasattr(node_response, "id") else node_response.get("id")
        if not node_id or node_id not in descendants_batch:
            if isinstance(node_response, dict):
                node_response["children"] = []
            else:
                node_response.children = []
            result.append(node_response)
            continue

        desc_ids = descendants_batch[node_id]
        all_descendants = [node_by_id[did] for did in desc_ids if did in node_by_id]

        if all_descendants:
            children_response = _build_children_response(all_descendants, class_ids_map)
            if isinstance(node_response, dict):
                node_response["children"] = [
                    c.model_dump() if hasattr(c, "model_dump") else c for c in children_response
                ]
            else:
                node_response.children = children_response
        else:
            if isinstance(node_response, dict):
                node_response["children"] = []
            else:
                node_response.children = []

        result.append(node_response)

    return result


async def _get_node_service(user: User) -> NodeService:
    from ...dependencies import _get_workspace_context_cached

    pool = await get_pool()
    user_id = int(user.id)

    workspace_id, page_class_id = await _get_workspace_context_cached(pool, user_id)

    # Create repositories with workspace context
    node_repo = PostgresNodeRepository(pool, workspace_id, page_class_id, user_id)
    property_repo = PostgresPropertyRepository(pool, workspace_id, user_id)
    link_repo = PostgresLinkRepository(pool, workspace_id, user_id)

    # Create services
    link_service = LinkParsingService(node_repo, link_repo)
    node_service = NodeService(
        node_repo,
        property_repo,
        link_service,
        page_class_id,
        pool=pool,
        workspace_id=workspace_id,
        user_id=user_id,
    )

    return node_service


async def _get_undo_service(user: User):
    """Get an UndoService for the current user's workspace."""
    from ...dependencies import _get_workspace_context_cached
    from ...domain.services.undo_service import UndoService

    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    return UndoService(pool, workspace_id, user_id)


def _node_snapshot(node) -> dict:
    """Capture the columns needed for undo/redo of a node."""
    return {
        "name": node.name,
        "icon": node.icon,
        "color": node.color,
        "parent_id": node.parent_id,
        "sequence": node.sequence,
        "collapsed": node.collapsed,
    }


def _name_text(name: str | None, max_len: int = 60) -> str:
    """Convert a node name (possibly AST JSON) to plain text for display in undo descriptions."""
    if not name:
        return ""
    try:
        from ...domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast

        ast = parse_ast(name, ParseMode.JSON)
        if ast:
            text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
            return text[:max_len] if text else ""
    except (ValueError, TypeError, KeyError):
        # Not valid AST JSON or AST processing error — return raw name
        pass
    return name[:max_len]


async def _resolve_referenced_display_names(pool, workspace_id: int, target_rows) -> dict[str, str]:
    """Resolve node links embedded in names and return uuid → resolved plain-text map.

    Only returns entries for rows whose names actually contain node links.
    Used by referenced_nodes builders so inline link pills show resolved text
    instead of "..." for blocks whose names reference other nodes.
    """
    import re

    from ...domain.stringify_ast import NodeLinkResolution, StringifyMode, StringifyOptions, parse_ast, stringify_ast

    link_node_uuids: set = set()
    for row in target_rows:
        name = row["name"] or ""
        for match in re.finditer(r'"link_id"\s*:\s*"([^"]+)"', name):
            link_id = match.group(1)
            colon = link_id.find(":")
            node_uuid = link_id[:colon] if colon > 0 else link_id
            link_node_uuids.add(node_uuid)

    link_target_map: dict[str, Any] = {}
    if link_node_uuids:
        async with acquire_connection(pool) as conn:
            uuid_list = list(link_node_uuids)
            placeholders = ", ".join(f"${i + 2}" for i in range(len(uuid_list)))
            rows = await conn.fetch(
                f"SELECT uuid, name FROM node WHERE workspace_id = $1 AND uuid::text IN ({placeholders})",
                workspace_id,
                *uuid_list,
            )
            for ref_row in rows:
                link_target_map[str(ref_row["uuid"])] = parse_ast(ref_row["name"])

    if not link_target_map:
        return {}

    def _resolve_link(link_id: str):
        colon = link_id.find(":")
        node_uuid = link_id[:colon] if colon > 0 else link_id
        target_ast = link_target_map.get(node_uuid)
        if target_ast is None:
            return None
        return NodeLinkResolution(target_ast=target_ast, label=None, target_id=node_uuid)

    opts = StringifyOptions(
        mode=StringifyMode.TEXT_ONLY,
        resolve_node_link=_resolve_link,
    )

    result: dict[str, str] = {}
    for row in target_rows:
        name = row["name"] or ""
        if '"link_id"' in name:
            resolved = stringify_ast(parse_ast(name), opts)
            if resolved:
                result[str(row["uuid"])] = resolved

    return result


def _format_date_with_pattern(year: int, month: int, day: int, pattern: str) -> str:
    """Format a date according to the given pattern.

    Returns a JSON-serialized AST document suitable for the name field.
    """
    from ...domain.stringify_ast import ParseMode, parse_ast, serialize_ast

    month_str = str(month).zfill(2)
    day_str = str(day).zfill(2)

    if pattern == "YYYY/MM/DD":
        text = f"{year}/{month_str}/{day_str}"
    elif pattern == "YYYY-MM-DD":
        text = f"{year}-{month_str}-{day_str}"
    elif pattern == "DD/MM/YYYY":
        text = f"{day_str}/{month_str}/{year}"
    elif pattern == "DD-MM-YYYY":
        text = f"{day_str}-{month_str}-{year}"
    elif pattern == "MM/DD/YYYY":
        text = f"{month_str}/{day_str}/{year}"
    elif pattern == "MM-DD-YYYY":
        text = f"{month_str}-{day_str}-{year}"
    else:
        text = f"{year}/{month_str}/{day_str}"

    return serialize_ast(parse_ast(text, ParseMode.PLAIN))


def _format_month_with_pattern(year: int, month: int, pattern: str) -> str:
    """Format a month according to the given pattern.

    Returns a JSON-serialized AST document suitable for the name field.
    """
    from ...domain.stringify_ast import ParseMode, parse_ast, serialize_ast

    month_str = str(month).zfill(2)
    separator = "/" if "/" in pattern else "-"

    if pattern.startswith("DD") or pattern.startswith("MM"):
        # European/US style
        text = f"{month_str}{separator}{year}"
    else:
        # ISO style
        text = f"{year}{separator}{month_str}"

    return serialize_ast(parse_ast(text, ParseMode.PLAIN))


def _format_year(year: int) -> str:
    """Format a year as an AST document.

    Returns a JSON-serialized AST document suitable for the name field.
    """
    from ...domain.stringify_ast import ParseMode, parse_ast, serialize_ast

    return serialize_ast(parse_ast(str(year), ParseMode.PLAIN))


async def _apply_node_extras(service, node_id: int, classes, properties) -> None:
    """Reconcile classes and apply property values alongside a core node update.

    - ``classes``: when not None, the node's classes are set to exactly this list
      (adds missing, removes extras).
    - ``properties``: dict of {property_id: value}; each pair is applied using
      the same dispatch logic as the ``POST /{node_id}/properties`` endpoint.
    """
    if classes is not None:
        current = set(await service._node_repo.get_node_class_ids(node_id))
        want = set(classes)
        for cls_id in want - current:
            await service.add_class(node_id, cls_id)
        for cls_id in current - want:
            await service.remove_class(node_id, cls_id)

    if properties:
        from ...domain.entities.property import RELATION_TYPES, SCALAR_TYPES

        repo = service.property_repo
        for prop_id, value in properties.items():
            prop = await repo.get_by_id(prop_id)
            if not prop:
                continue
            if prop.type in SCALAR_TYPES:
                await repo.set_scalar_value(node_id, prop_id, value)
            elif prop.type in RELATION_TYPES:
                if value == "" or value is None:
                    await repo.assign_property_to_node(node_id, prop_id)
                elif isinstance(value, list):
                    unique_vals = list(dict.fromkeys(value))
                    await repo.clear_relation_values(node_id, prop_id)
                    for target_id in unique_vals:
                        await repo.set_relation_value(node_id, prop_id, int(target_id))
                else:
                    await repo.set_relation_value(node_id, prop_id, int(value))
            else:  # SELECTION
                if value == "" or value is None:
                    await repo.assign_property_to_node(node_id, prop_id)
                elif isinstance(value, list):
                    unique_vals = list(dict.fromkeys(value))
                    await repo.clear_selection_values(node_id, prop_id)
                    for sel_id in unique_vals:
                        await repo.set_selection_value(node_id, prop_id, int(sel_id))
                else:
                    await repo.set_selection_value(node_id, prop_id, int(value))
