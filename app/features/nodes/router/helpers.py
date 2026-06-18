"""Helper functions for the Nodes API."""

import json
from typing import Any

from app.dependencies import (
    _get_node_service,
    _get_undo_service,
)
from app.domain.entities import Node
from app.domain.permissions import PermissionChecker
from app.features.nodes.node_service import NodeService
from app.logging_config import get_logger

from .models import NodeResponse

logger = get_logger(__name__)

__all__ = [
    "_get_node_service",
    "_get_undo_service",
    "extract_properties_dict",
    "_node_to_response",
    "_node_to_response_with_permissions",
    "_build_children_response",
    "_build_node_detail_response",
    "_get_descendants",
    "_get_class_ids",
    "_get_tag_ids",
    "_get_alias_ids",
    "_get_class_ids_batch",
    "_get_extends_batch",
    "_get_related_ids_batch",
    "_get_effective_class_ids_batch",
    "_build_children_tree",
    "_node_snapshot",
    "_name_text",
    "_resolve_referenced_display_names",
    "_format_date_with_pattern",
    "_format_month_with_pattern",
    "_format_year",
]


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
        is_task=node.is_task,
        is_table=node.is_table,
        is_comment=node.is_comment,
        parent_locked=node.parent_locked,
        is_private=node.is_private,
        create_date=node.create_date,
        write_date=node.write_date,
        open_date=node.open_date,
        display_name=node.display_name,
        tags=tags or [],
        classes=classes if classes is not None else node.class_ids,
        comment_count=comment_count,
        backlink_count=backlink_count,
        classes_path=json.loads(node.classes_path) if isinstance(node.classes_path, str) else (node.classes_path or []),
        aliased_id=node.aliased_id,
        aliases=aliases or [],
        has_children=has_children,
        extends=extends or [],
    )


async def _node_to_response_with_permissions(
    node: Node,
    permission_checker: PermissionChecker,
    **kwargs,
) -> NodeResponse:
    """Convert domain Node to API response and inject resolved permissions."""
    response = _node_to_response(node, **kwargs)
    if node.id is not None:
        response.permissions = {
            "can_read": await permission_checker.can_read_node(node.id),
            "can_write": await permission_checker.can_write_node(node.id),
            "can_create": await permission_checker.can_create_in_node(node.id),
            "can_delete": await permission_checker.can_delete_node(node.id),
        }
    return response


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
                parent.has_children = True
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


async def _get_tag_ids(service: NodeService, node_id: int) -> list[int]:
    """Helper to get tag IDs for a node (from node.tag_ids column)."""
    return await service.get_tag_link_targets(node_id)


async def _get_alias_ids(service: NodeService, node_id: int) -> list[int]:
    """Helper to get alias IDs for a node (nodes that have aliased_id = node_id)."""
    return await service.get_alias_node_ids(node_id)


async def _get_class_ids_batch(service: NodeService, node_ids: list[int]) -> dict[int, list[int]]:
    """Efficiently fetch class_ids directly from node table.

    Returns a dict mapping node_id -> list of class_ids.
    """
    return await service.get_class_ids_batch(node_ids)


async def _get_extends_batch(service: NodeService, node_ids: list[int]) -> dict[int, list[int]]:
    """Batch-fetch class extends (parent class IDs) for a set of class nodes.

    Returns a dict mapping target_id (child class) -> list of source_ids (parent classes)
    in sequence order.
    """
    return await service.get_extended_classes_batch(node_ids)


async def _get_related_ids_batch(
    service: NodeService,
    node_ids: list[int],
    relation_type: str,
) -> dict[int, list[int]]:
    """Generic batch-fetch for IDs related to a set of source node IDs.

    Args:
        service: NodeService wired to the current workspace.
        node_ids: Source node IDs to look up relations for.
        relation_type: One of 'tags', 'aliases', 'classes'.

    Returns:
        Dict mapping source node_id -> list of related IDs.
    """
    return await service.get_related_ids_batch(node_ids, relation_type)


async def _get_effective_class_ids_batch(
    service: NodeService, node_ids: list[int]
) -> dict[int, list[int]]:
    """Fetch class_ids for multiple nodes including inherited classes from extends."""
    return await service.get_effective_class_ids_batch(node_ids)


async def _build_children_tree(
    service: NodeService,
    nodes: list[Any],
    class_ids_map: dict[int, list[int]],
) -> list[Any]:
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
        desc_class_ids = await _get_class_ids_batch(service, all_descendant_ids)
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
                node_response["has_children"] = True
            else:
                node_response.children = children_response
                node_response.has_children = True
        else:
            if isinstance(node_response, dict):
                node_response["children"] = []
            else:
                node_response.children = []

        result.append(node_response)

    # Remove any root that already appears as a child of another root.
    def _collect_child_ids(children: list[Any]) -> set[int]:
        ids: set[int] = set()
        for child in children:
            child_id = child.get("id") if isinstance(child, dict) else getattr(child, "id", None)
            if child_id is not None:
                ids.add(child_id)
            child_children = child.get("children") if isinstance(child, dict) else getattr(child, "children", None)
            if child_children:
                ids.update(_collect_child_ids(child_children))
        return ids

    all_child_ids: set[int] = set()
    for node_response in result:
        children = node_response.get("children") if isinstance(node_response, dict) else getattr(node_response, "children", None)
        if children:
            all_child_ids.update(_collect_child_ids(children))

    result = [r for r in result if (r.get("id") if isinstance(r, dict) else getattr(r, "id", None)) not in all_child_ids]

    return result


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
        from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast

        ast = parse_ast(name, ParseMode.JSON)
        if ast:
            text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
            return text[:max_len] if text else ""
    except (ValueError, TypeError, KeyError):
        # Not valid AST JSON or AST processing error — return raw name
        pass
    return name[:max_len]


async def _build_node_detail_response(
    service: NodeService,
    node_id: int,
    include_children: bool = False,
    include_backlinks: bool = False,
    include_properties: bool = False,
) -> NodeResponse | None:
    """Build a fully-assembled NodeResponse for a single node.

    Handles child-tree assembly, backlink formatting, property extraction,
    and referenced-node resolution so the router stays a thin HTTP adapter.
    """
    from .models import BacklinkResponse, BreadcrumbSegment

    node = await service.get_node_by_id(node_id)
    if not node:
        return None

    class_ids = await _get_class_ids(service, node_id)
    tag_ids = await _get_tag_ids(service, node_id)
    alias_ids = await _get_alias_ids(service, node_id)

    response = await _node_to_response_with_permissions(
        node, service.permissions, tags=tag_ids, classes=class_ids, aliases=alias_ids
    )

    if include_children:
        children_data = await service.load_node_children(
            node_id, include_properties=include_properties
        )
        visible_descendants = children_data["descendants"]
        children_of = children_data["children_of"]
        backlink_counts = children_data["backlink_counts"]
        node_properties_raw = children_data["node_properties_map"]
        referenced_targets = children_data["referenced_nodes"]

        descendant_ids = [d.id for d in visible_descendants if d.id is not None]
        node_class_map = await _get_class_ids_batch(service, descendant_ids)

        node_properties_map: dict[int, dict[str, Any]] = {}
        if include_properties:
            for nid, prop_data in node_properties_raw.items():
                node_properties_map[nid] = extract_properties_dict(prop_data)

        node_map: dict[int, NodeResponse] = {}
        for d in visible_descendants:
            if d.id is not None:
                bcount = backlink_counts.get(d.id, 0)
                d_class_ids = node_class_map.get(d.id, [])
                node_resp = _node_to_response(d, classes=d_class_ids, backlink_count=bcount)
                node_resp.has_children = d.id in children_of
                if include_properties and d.id in node_properties_map:
                    node_resp.properties = node_properties_map[d.id]
                node_map[d.id] = node_resp

        root_children = []
        for d in visible_descendants:
            if d.id is None:
                continue
            node_response = node_map[d.id]
            if d.parent_id == node_id:
                root_children.append(node_response)
            elif d.parent_id in node_map:
                parent = node_map[d.parent_id]
                if parent.children is None:
                    parent.children = []
                parent.children.append(node_response)

        response.children = root_children

        if referenced_targets:
            display_names = await _resolve_referenced_display_names(
                service, referenced_targets
            )
            referenced_nodes: dict[str, NodeResponse] = {}
            for target in referenced_targets:
                uuid_str = str(target.uuid)
                referenced_nodes[uuid_str] = NodeResponse(
                    id=target.id or 0,
                    uuid=uuid_str,
                    name=target.name or "",
                    icon=target.icon,
                    color=target.color,
                    is_page=target.is_page,
                    is_class=target.is_class,
                    create_date=str(target.create_date),
                    write_date=str(target.write_date),
                    parent_id=target.parent_id,
                    page_id=target.page_id,
                    sequence=target.sequence,
                    collapsed=target.collapsed,
                    active=target.active,
                    display_name=display_names.get(uuid_str),
                    classes=list(target.class_ids or []),
                )
            response.referenced_nodes = referenced_nodes

    if include_backlinks:
        backlink_infos = await service.get_backlinks(node_id)
        response.backlinks = []
        for info in backlink_infos:
            breadcrumb_segments = [
                BreadcrumbSegment(
                    node_id=seg[0],
                    name=seg[1],
                    is_property=seg[2] if len(seg) > 2 else False,
                )
                for seg in info.breadcrumb_path
            ]
            response.backlinks.append(
                BacklinkResponse(
                    source_node_id=info.source_node_id,
                    source_node_uuid=str(info.source_node_uuid) if info.source_node_uuid else "",
                    source_node_name=info.source_node_name or "",
                    source_is_page=info.source_is_page,
                    source_page_id=info.source_page_id,
                    source_page_name=info.source_page_name,
                    source_page_uuid=str(info.source_page_uuid) if info.source_page_uuid else None,
                    property_id=info.property_id,
                    property_name=info.property_name,
                    breadcrumb_path=breadcrumb_segments,
                    link_type="property" if info.property_id else "text",
                    position=info.link.position,
                )
            )

    if include_properties:
        all_prop_values = await service.get_node_properties(node_id)
        response.properties = extract_properties_dict(all_prop_values)

    return response


async def _resolve_referenced_display_names(service: NodeService, target_rows) -> dict[str, str]:
    """Resolve node links embedded in names and return uuid → resolved plain-text map.

    Only returns entries for rows whose names actually contain node links.
    Used by referenced_nodes builders so inline link pills show resolved text
    instead of "..." for blocks whose names reference other nodes.

    ``target_rows`` may be asyncpg records, domain Node objects, or dicts.
    """
    return await service.resolve_referenced_display_names(target_rows)


def _format_date_with_pattern(year: int, month: int, day: int, pattern: str) -> str:
    """Format a date according to the given pattern.

    Returns a JSON-serialized AST document suitable for the name field.
    """
    from app.domain.stringify_ast import ParseMode, parse_ast, serialize_ast

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
    from app.domain.stringify_ast import ParseMode, parse_ast, serialize_ast

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
    from app.domain.stringify_ast import ParseMode, parse_ast, serialize_ast

    return serialize_ast(parse_ast(str(year), ParseMode.PLAIN))


