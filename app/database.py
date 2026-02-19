"""Workspace management operations for Notees.

This module handles workspace management operations:
- Listing, creating, switching, renaming, deleting workspaces
- Import/export functionality

A "workspace" is a user's personal knowledge workspace (formerly called "workspace").

For node operations, use:
- app/domain/repositories (PostgreSQL implementations)
- app/routers/nodes.py (REST API endpoints)
"""
from pathlib import Path
from typing import Optional, Dict, List, Any

from .config import settings
from .logging_config import get_logger
from .db.connection import get_connection, DATA_DIR, get_workspace_dir
from .db.schema.init import seed_workspace, get_or_create_user_workspace
from .domain.stringify_ast import (
    parse_ast,
    stringify_ast,
    StringifyMode,
    StringifyOptions,
    NodeLinkResolution,
)

logger = get_logger(__name__)

# Track active workspace per user (in-memory, for session)
# Maps user_id (str) -> workspace UUID (str)
_active_workspaces: Dict[str, str] = {}


# ============== Workspace Management ==============

async def _get_numeric_user_id(user_id: str) -> Optional[int]:
    """Convert string user_id to numeric PostgreSQL ID.
    
    Args:
        user_id: String user ID (either numeric or UUID format)
        
    Returns:
        Numeric user ID or None if not found
    """
    async with get_connection() as conn:
        row = await conn.fetchrow(
            'SELECT id FROM "user" WHERE id::text = $1 OR uuid::text = $1',
            user_id
        )
        return row['id'] if row else None


async def list_workspaces(user_id: str) -> List[Dict[str, Any]]:
    """List all workspaces accessible to a user.
    
    Returns workspaces owned by the user and workspaces shared with them.
    
    Args:
        user_id: User ID (string or UUID)
        
    Returns:
        List of workspace info dicts with uuid, name, created_at, updated_at, is_shared
    """
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        return []
    
    async with get_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT g.uuid, g.name, g.create_date, g.write_date, g.is_shared
            FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.create_uid = $1 OR gs.user_id = $1
            ORDER BY g.create_date DESC
            """,
            numeric_user_id
        )
        
        return [
            {
                "uuid": str(row['uuid']),
                "name": row['name'],
                "created_at": row['create_date'].isoformat() if row['create_date'] else None,
                "updated_at": row['write_date'].isoformat() if row['write_date'] else None,
                "is_shared": row['is_shared'],
            }
            for row in rows
        ]


def get_active_workspace_id(user_id: str) -> Optional[str]:
    """Get the active workspace UUID for a user.
    
    Args:
        user_id: User ID
        
    Returns:
        Active workspace UUID or None
    """
    return _active_workspaces.get(user_id)


async def create_workspace(user_id: str, name: str) -> Dict[str, Any]:
    """Create a new workspace for a user.
    
    Args:
        user_id: User ID (string or UUID)
        name: Workspace name (must be unique per user)
        
    Returns:
        Dict with workspace info (uuid, name, created_at)
        
    Raises:
        ValueError: If user not found or workspace name exists
        RuntimeError: If creation fails
    """
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")
    
    async with get_connection() as conn:
        # Check if name already exists for this user
        existing = await conn.fetchrow(
            "SELECT id FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE",
            numeric_user_id, name
        )
        if existing:
            raise ValueError(f"Workspace '{name}' already exists")
        
        # Create workspace
        row = await conn.fetchrow(
            """
            INSERT INTO workspace (name, create_uid, write_uid, is_shared, active)
            VALUES ($1, $2, $2, FALSE, TRUE)
            RETURNING id, uuid, name, create_date
            """,
            name, numeric_user_id
        )
        if row is None:
            raise RuntimeError("Failed to create workspace")
        
        workspace_id = row['id']
        
        # Seed workspace with system types, properties, and default pages
        logger.info(f"Seeding workspace {workspace_id} with system data")
        await seed_workspace(conn, workspace_id, numeric_user_id)
        
        result = {
            "uuid": str(row['uuid']),
            "name": row['name'],
            "created_at": row['create_date'].isoformat() if row['create_date'] else None,
        }
        
        # Auto-activate newly created workspace
        _active_workspaces[user_id] = str(row['uuid'])
        
        return result


async def switch_workspace(user_id: str, workspace_uuid: str) -> bool:
    """Switch to a different workspace.
    
    Args:
        user_id: User ID
        workspace_uuid: Workspace UUID to switch to
        
    Returns:
        True if switch successful, False if workspace not found/accessible
    """
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        return False
    
    async with get_connection() as conn:
        # Check user owns or has access to the workspace
        workspace = await conn.fetchrow(
            """
            SELECT g.id FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $1 AND g.active = TRUE 
              AND (g.create_uid = $2 OR gs.user_id = $2)
            """,
            workspace_uuid, numeric_user_id
        )
        
        if not workspace:
            return False
        
        _active_workspaces[user_id] = workspace_uuid
        return True


async def rename_workspace(user_id: str, old_name: str, new_name: str) -> Dict[str, Any]:
    """Rename a workspace.
    
    Only the workspace owner can rename it.
    
    Args:
        user_id: User ID (must be owner)
        old_name: Current workspace name
        new_name: New workspace name
        
    Returns:
        Dict with updated workspace info
        
    Raises:
        ValueError: If user not found, workspace not found, or new name exists
        RuntimeError: If rename fails
    """
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")
    
    async with get_connection() as conn:
        # Find workspace owned by user
        old_workspace = await conn.fetchrow(
            "SELECT id, uuid FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE",
            numeric_user_id, old_name
        )
        if not old_workspace:
            raise ValueError(f"Workspace '{old_name}' not found")
        
        # Check new name doesn't exist
        existing = await conn.fetchrow(
            "SELECT id FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE",
            numeric_user_id, new_name
        )
        if existing:
            raise ValueError(f"Workspace '{new_name}' already exists")
        
        # Update workspace name
        row = await conn.fetchrow(
            """
            UPDATE workspace SET name = $1, write_date = NOW(), write_uid = $3
            WHERE id = $2
            RETURNING uuid, name, create_date
            """,
            new_name, old_workspace['id'], numeric_user_id
        )
        if row is None:
            raise RuntimeError("Failed to rename workspace")
        
        # Update active workspace tracking
        if _active_workspaces.get(user_id) == old_name:
            _active_workspaces[user_id] = new_name
        
        return {
            "uuid": str(row['uuid']),
            "name": row['name'],
            "created_at": row['create_date'].isoformat() if row['create_date'] else None,
        }


async def delete_workspace(user_id: str, name: str) -> bool:
    """Delete a workspace.
    
    Only the workspace owner can delete it. This is a hard delete.
    Deletes both the database record and the associated assets folder.
    
    Args:
        user_id: User ID (must be owner)
        name: Workspace name to delete
        
    Returns:
        True if deleted, False if not found
    """
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        return False
    
    async with get_connection() as conn:
        # First, get the workspace UUID before deletion
        workspace_row = await conn.fetchrow(
            "SELECT uuid FROM workspace WHERE create_uid = $1 AND name = $2",
            numeric_user_id, name
        )
        
        if not workspace_row:
            return False
        
        workspace_uuid = str(workspace_row['uuid'])
        
        # Delete the workspace from database (CASCADE will delete related data)
        result = await conn.execute(
            "DELETE FROM workspace WHERE create_uid = $1 AND name = $2",
            numeric_user_id, name
        )
        
        deleted = result.split()[-1] != '0'
        
        if deleted:
            # Delete the workspace folder (assets, exports, etc.)
            workspace_dir_path = get_workspace_dir(workspace_uuid)
            if workspace_dir_path.exists():
                try:
                    shutil.rmtree(workspace_dir_path)
                    logger.info(f"Deleted workspace folder: {workspace_dir_path}")
                except Exception as e:
                    logger.error(f"Failed to delete workspace folder {workspace_dir_path}: {e}", exc_info=True)
                    # Continue even if folder deletion fails
            
            # Clear from active tracking
            if _active_workspaces.get(user_id) == name:
                del _active_workspaces[user_id]
        
        return deleted


async def export_workspace(user_id: str, name: str) -> Path:
    """Export a workspace to a JSON file.
    
    Exports all nodes, links, properties, property values, class definitions,
    node views, and settings in the workspace.
    
    Args:
        user_id: User ID
        name: Workspace name to export
        
    Returns:
        Path to the exported JSON file
        
    Raises:
        ValueError: If user or workspace not found
    """
    from .workspace_io import export_workspace_to_file
    return await export_workspace_to_file(user_id, name)


async def import_workspace(user_id: str, file_path: Path, name: str) -> Dict[str, Any]:
    """Import a workspace from a JSON dump file.
    
    Creates a new workspace with all UUIDs remapped to new unique values.
    
    Args:
        user_id: User ID
        file_path: Path to the JSON dump file
        name: Name for the new workspace
        
    Returns:
        Dict with new workspace info and import stats
    """
    import json
    from .workspace_io import import_dump_to_new_workspace
    
    with open(file_path, 'r', encoding='utf-8') as f:
        dump_data = json.load(f)
    
    return await import_dump_to_new_workspace(user_id, dump_data, name)


async def export_nodes(
    user_id: str,
    node_ids: List[str],
    format: Any,  # ExportFormat enum
    include_children: bool = True,
    layout: str = "outline",
    formatting: bool = True,
    style: str | None = None,
    properties: str = "none",  # "none" | "main" | "all"
    density: str = "comfortable",  # "comfortable" | "compact"
    numbering: str = "none",  # "none" | "top-level" | "hierarchical"
) -> tuple:
    """Export nodes to various formats.
    
    Args:
        user_id: User ID
        node_ids: List of node UUIDs to export
        format: Export format (markdown, html, pdf)
        include_children: Whether to include child nodes
        layout: 'outline' (indented hierarchy) or 'flat' (top node as header, rest as flat list)
    
    Returns:
        Tuple of (content: bytes, filename: str, mime_type: str)
        
    Raises:
        ValueError: If user not found or no nodes found
    """
    from .models import ExportFormat
    
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")
    
    # Resolve workspace using the same logic as the rest of the app
    active_uuid = _active_workspaces.get(user_id)
    
    async with get_connection() as conn:
        workspace_id = await get_or_create_user_workspace(conn, numeric_user_id, workspace_uuid=active_uuid)
        
        # Fetch nodes
        nodes_data = []
        seen_uuids: set[str] = set()
        for node_uuid in node_ids:
            if include_children:
                # Recursive CTE: depth-first traversal in sibling (sequence) order.
                # Base case is the root page itself; recursion adds non-page children only,
                # so child pages are never crossed into.
                # path_order accumulates (sequence, id) pairs so siblings are ordered
                # correctly and parents always appear before their children.
                rows = await conn.fetch(
                    """
                    WITH RECURSIVE tree AS (
                        SELECT n.id, n.uuid, n.name, n.parent_id, n.is_page, n.color,
                               0 AS depth,
                               ARRAY[n.sequence, n.id] AS path_order
                        FROM node n
                        WHERE n.workspace_id = $1 AND n.uuid::text = $2
                          AND n.is_deleted = FALSE AND n.active = TRUE
                        UNION ALL
                        SELECT n.id, n.uuid, n.name, n.parent_id, n.is_page, n.color,
                               t.depth + 1,
                               t.path_order || ARRAY[n.sequence, n.id]
                        FROM node n
                        JOIN tree t ON n.parent_id = t.id
                        WHERE n.workspace_id = $1
                          AND n.is_deleted = FALSE
                          AND n.active = TRUE
                          AND n.is_page = FALSE
                          -- Exclude blocks that are text property values (shown in properties panel)
                          AND NOT EXISTS (
                              SELECT 1
                              FROM property_value_relation pvr
                              JOIN property p ON p.id = pvr.property_id
                              WHERE pvr.target_id = n.id
                                AND p.type = 'text'
                                AND p.workspace_id = $1
                          )
                    )
                    SELECT id, uuid, name, parent_id, is_page, color, depth
                    FROM tree
                    ORDER BY path_order
                    """,
                    workspace_id, node_uuid
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT id, uuid, name, parent_id, is_page, color
                    FROM node 
                    WHERE workspace_id = $1 AND uuid::text = $2
                    """,
                    workspace_id, node_uuid
                )
            
            for row in rows:
                row_uuid = str(row['uuid'])
                if row_uuid in seen_uuids:
                    continue
                seen_uuids.add(row_uuid)
                nodes_data.append({
                    "id": row['id'],
                    "uuid": row_uuid,
                    "name": row['name'],
                    "is_page": row.get('is_page', False),
                    "color": row.get('color') or None,
                    "depth": row.get('depth', 0) if include_children else 0,
                })

        if not nodes_data:
            raise ValueError("No nodes found to export")

        # ── Resolve node links in all ASTs ──
        # 1. Walk all ASTs and collect target node UUIDs from link_ids
        target_uuids: set[str] = set()
        for nd in nodes_data:
            ast = parse_ast(nd['name'])
            nd['_ast'] = ast  # cache parsed AST
            _collect_link_target_uuids(ast, target_uuids)

        # 2. Batch-fetch target node names keyed by UUID
        link_target_map: Dict[str, list] = {}  # nodeUuid → name AST
        if target_uuids:
            placeholders = ', '.join(f'${i+2}' for i in range(len(target_uuids)))
            target_rows = await conn.fetch(
                f"SELECT uuid, name FROM node WHERE workspace_id = $1 AND uuid::text IN ({placeholders})",
                workspace_id, *list(target_uuids)
            )
            for tr in target_rows:
                link_target_map[str(tr['uuid'])] = parse_ast(tr['name'])

        # 3. Build resolver: link_id ("nodeUuid:linkUuid") → NodeLinkResolution
        def resolve_node_link(link_id: str):
            colon = link_id.find(':')
            node_uuid = link_id[:colon] if colon > 0 else link_id
            target_ast = link_target_map.get(node_uuid)
            if target_ast is None:
                return None
            return NodeLinkResolution(
                target_ast=target_ast,
                label=None,
                target_id=node_uuid,
            )

        # 4. Fetch properties for page nodes if requested
        properties_data: Dict[str, list] = {}  # uuid → [{name, icon, type, values: [str]}]
        if properties in ("main", "all"):
            page_node_ids = [nd['id'] for nd in nodes_data if nd.get('is_page') and nd.get('id')]
            if page_node_ids:
                include_system = (properties == "all")
                prop_rows = await conn.fetch(
                    f"""
                    SELECT
                        np.node_id,
                        n.uuid::text as node_uuid,
                        p.name   AS property_name,
                        p.icon   AS property_icon,
                        p.type   AS property_type,
                        p.is_system,
                        p.is_multi,
                        pvs.value_text,
                        pvs.value_boolean,
                        pvs.value_float,
                        pvs.value_integer,
                        psl.name AS selection_value,
                        pvr.target_id AS relation_target_id
                    FROM node_property np
                    JOIN node n ON n.id = np.node_id
                    JOIN property p ON p.id = np.property_id
                    LEFT JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    LEFT JOIN property_value_relation pvr ON pvr.node_property_id = np.id
                    LEFT JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
                    LEFT JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                    WHERE np.node_id = ANY($1)
                      AND p.active = TRUE
                      {'AND p.is_system = FALSE' if not include_system else ''}
                    ORDER BY np.node_id, p.name
                    """,
                    page_node_ids
                )
                # Collect relation target IDs to resolve names
                relation_target_ids = {row['relation_target_id'] for row in prop_rows if row['relation_target_id']}
                relation_target_names: Dict[int, str] = {}
                if relation_target_ids:
                    rel_rows = await conn.fetch(
                        "SELECT id, name FROM node WHERE id = ANY($1)",
                        list(relation_target_ids)
                    )
                    for rr in rel_rows:
                        relation_target_names[rr['id']] = _stringify_node(
                            {'name': rr['name'], '_ast': parse_ast(rr['name'])},
                            StringifyMode.TEXT_ONLY, None
                        )
                # Aggregate: uuid → {prop_name → {name, icon, type, values}}
                agg: Dict[str, Dict[str, dict]] = {}
                for row in prop_rows:
                    node_uuid_key = row['node_uuid']
                    prop_name = row['property_name']
                    prop_type = row['property_type']
                    if node_uuid_key not in agg:
                        agg[node_uuid_key] = {}
                    if prop_name not in agg[node_uuid_key]:
                        agg[node_uuid_key][prop_name] = {
                            'name': prop_name,
                            'icon': row['property_icon'],
                            'type': prop_type,
                            'values': [],
                        }
                    entry = agg[node_uuid_key][prop_name]
                    value_str: str | None = None
                    if prop_type == 'integer' and row['value_integer'] is not None:
                        value_str = str(row['value_integer'])
                    elif prop_type == 'float' and row['value_float'] is not None:
                        value_str = str(row['value_float'])
                    elif prop_type == 'boolean' and row['value_boolean'] is not None:
                        value_str = 'Yes' if row['value_boolean'] else 'No'
                    elif prop_type == 'date' and row['value_text'] is not None:
                        value_str = row['value_text']
                    elif prop_type in ('node', 'text') and row['relation_target_id'] is not None:
                        value_str = relation_target_names.get(row['relation_target_id'])
                    elif prop_type == 'selection' and row['selection_value'] is not None:
                        value_str = row['selection_value']
                    if value_str is not None and value_str not in entry['values']:
                        entry['values'].append(value_str)

                # ── Classes ──
                # Fetch class_ids for page nodes, then resolve names
                class_id_rows = await conn.fetch(
                    "SELECT id, uuid::text as uuid, class_ids FROM node WHERE id = ANY($1) AND class_ids != '{}'",
                    page_node_ids
                )
                if class_id_rows:
                    all_class_ids = list({cid for r in class_id_rows for cid in (r['class_ids'] or [])})
                    class_name_rows = await conn.fetch(
                        "SELECT id, name FROM node WHERE id = ANY($1) AND active = TRUE",
                        all_class_ids
                    )
                    class_name_map: Dict[int, str] = {
                        r['id']: _stringify_node(
                            {'name': r['name'], '_ast': parse_ast(r['name'])},
                            StringifyMode.TEXT_ONLY, None
                        )
                        for r in class_name_rows
                    }
                    for r in class_id_rows:
                        node_uuid_key = r['uuid']
                        names = [class_name_map[cid] for cid in (r['class_ids'] or []) if cid in class_name_map]
                        if names:
                            if node_uuid_key not in agg:
                                agg[node_uuid_key] = {}
                            agg[node_uuid_key]['classes'] = {
                                'name': 'classes',
                                'icon': None,
                                'type': 'classes',
                                'values': names,
                            }

                # ── Tags ──
                tag_rows = await conn.fetch(
                    """
                    SELECT nl.source_id, n.uuid::text as source_uuid, t.name as tag_name
                    FROM node_link nl
                    JOIN node n ON n.id = nl.source_id
                    JOIN node t ON t.id = nl.target_id
                    WHERE nl.source_id = ANY($1)
                      AND nl.is_tag = TRUE
                      AND nl.workspace_id = $2
                    ORDER BY nl.source_id, t.name
                    """,
                    page_node_ids, workspace_id
                )
                for r in tag_rows:
                    node_uuid_key = r['source_uuid']
                    tag_label = _stringify_node(
                        {'name': r['tag_name'], '_ast': parse_ast(r['tag_name'])},
                        StringifyMode.TEXT_ONLY, None
                    )
                    if node_uuid_key not in agg:
                        agg[node_uuid_key] = {}
                    if 'tags' not in agg[node_uuid_key]:
                        agg[node_uuid_key]['tags'] = {
                            'name': 'tags',
                            'icon': None,
                            'type': 'tags',
                            'values': [],
                        }
                    if tag_label not in agg[node_uuid_key]['tags']['values']:
                        agg[node_uuid_key]['tags']['values'].append(tag_label)

                # Build final sorted list: classes and tags first, then alpha properties
                for node_uuid_key, props in agg.items():
                    pinned = [p for p in props.values() if p['type'] in ('classes', 'tags')]
                    rest = sorted(
                        [p for p in props.values() if p['type'] not in ('classes', 'tags')],
                        key=lambda p: p['name']
                    )
                    properties_data[node_uuid_key] = pinned + rest

    # Generate content based on format
    if format == ExportFormat.MARKDOWN or format == "markdown":
        content = _export_to_markdown(nodes_data, resolve_node_link, layout, formatting, properties_data)
        filename = "export.md"
        mime_type = "text/markdown"
    elif format == ExportFormat.HTML or format == "html":
        content = _export_to_html(nodes_data, resolve_node_link, layout, formatting, style, properties_data, density, numbering)
        filename = "export.html"
        mime_type = "text/html"
    elif format == ExportFormat.PDF or format == "pdf":
        html_content = _export_to_html(nodes_data, resolve_node_link, layout, formatting, style, properties_data, density, numbering)
        try:
            from weasyprint import HTML as WeasyprintHTML
            pdf_bytes = WeasyprintHTML(string=html_content).write_pdf()
            return pdf_bytes, "export.pdf", "application/pdf"
        except Exception as e:
            logger.warning(f"WeasyPrint PDF generation failed: {e}; falling back to HTML")
            return html_content.encode('utf-8'), "export.html", "text/html"
    else:
        raise ValueError(f"Unsupported format: {format}")
    
    return content.encode('utf-8'), filename, mime_type


def _collect_link_target_uuids(ast_nodes: list, out: set[str]) -> None:
    """Recursively walk AST nodes and collect target node UUIDs from node_link link_ids."""
    for node in ast_nodes:
        if not isinstance(node, dict):
            continue
        if node.get('type') == 'node_link':
            link_id = node.get('link_id', '')
            colon = link_id.find(':')
            node_uuid = link_id[:colon] if colon > 0 else link_id
            if node_uuid:
                out.add(node_uuid)
        # Recurse into children
        children = node.get('children')
        if children:
            _collect_link_target_uuids(children, out)


def _stringify_node(node_data: Dict, mode: StringifyMode, resolver, html_anchors: bool = False) -> str:
    """Stringify a single node's AST to text."""
    ast = node_data.get('_ast') or parse_ast(node_data.get('name', ''))
    opts = StringifyOptions(mode=mode, resolve_node_link=resolver, html_anchors=html_anchors)
    return stringify_ast(ast, opts)


def _markdown_inline_to_html(md: str) -> str:
    """Convert PLAIN_MARKDOWN inline syntax to HTML with proper escaping.

    Tokenises the string produced by stringify_ast(PLAIN_MARKDOWN) so that:
    - User-typed text segments are HTML-escaped.
    - Markdown formatting tokens are translated to the matching HTML element.

    Supported tokens (in priority order):
        ``code``              → <code>…</code>
        **bold**              → <strong>…</strong>
        *italic*              → <em>…</em>
        ~~strikethrough~~     → <s>…</s>
        ==highlight==         → <mark>…</mark>
        <u>underline</u>      → <u>…</u>  (already emitted by stringify)
        [text](url)           → <a href="url">text</a>
    """
    import re as _re
    import html as _html

    TOKEN_RE = _re.compile(
        r'(`[^`]+`)'              # code — highest priority to protect contents
        r'|(\*\*.+?\*\*)'        # bold
        r'|(\*.+?\*)'            # italic
        r'|(~~.+?~~)'             # strikethrough
        r'|(==.+?==)'             # highlight
        r'|(<u>.+?</u>)'          # underline (already HTML from stringify)
        r'|(\[.+?\]\([^)]+\))',  # external link
        _re.DOTALL,
    )

    result: list[str] = []
    last = 0
    for m in TOKEN_RE.finditer(md):
        # Escape plain text before this token
        if m.start() > last:
            result.append(_html.escape(md[last:m.start()]))
        token = m.group(0)
        if token.startswith('`'):
            result.append(f'<code>{_html.escape(token[1:-1])}</code>')
        elif token.startswith('**'):
            result.append(f'<strong>{_html.escape(token[2:-2])}</strong>')
        elif token.startswith('*'):
            result.append(f'<em>{_html.escape(token[1:-1])}</em>')
        elif token.startswith('~~'):
            result.append(f'<s>{_html.escape(token[2:-2])}</s>')
        elif token.startswith('=='):
            result.append(f'<mark>{_html.escape(token[2:-2])}</mark>')
        elif token.startswith('<u>'):
            result.append(f'<u>{_html.escape(token[3:-4])}</u>')
        else:
            lm = _re.match(r'\[(.+?)\]\(([^)]+)\)', token)
            if lm:
                result.append(f'<a href="{_html.escape(lm.group(2))}">{_html.escape(lm.group(1))}</a>')
            else:
                result.append(_html.escape(token))
        last = m.end()
    # Remaining plain text
    if last < len(md):
        result.append(_html.escape(md[last:]))
    return ''.join(result)


def _export_to_markdown(
    nodes: List[Dict],
    resolver=None,
    layout: str = "outline",
    formatting: bool = True,
    properties_data: Dict[str, list] | None = None,
) -> str:
    """Convert nodes to Markdown format.

    Page nodes (is_page=True) always render as ATX headings at their depth level.
    Non-page nodes render as indented bullets (outline) or plain lines (flat).
    After each page heading, assigned properties are emitted as:
        propertyname:: value
    """
    if not nodes:
        return ""

    _props = properties_data or {}

    lines = []
    for node in nodes:
        text = _stringify_node(node, StringifyMode.PLAIN_MARKDOWN, resolver)
        depth = node.get('depth', 0)
        is_page = node.get('is_page', False)

        # Colored nodes use ==highlight== syntax
        if formatting and node.get('color'):
            text = f"=={text}=="

        if is_page:
            hashes = '#' * (depth + 1)
            lines.append(f"{hashes} {text}")
            # Emit property:: value lines immediately after the heading
            props = _props.get(node.get('uuid', ''), [])
            for p in props:
                values = p['values']
                if values:
                    lines.append(f"{p['name']}:: {', '.join(values)}")
                else:
                    lines.append(f"{p['name']}::")
        elif layout == "flat":
            lines.append(text)
        else:
            # outline
            indent = '  ' * depth
            lines.append(f"{indent}- {text}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Default export stylesheet
# Export CSS lives in app/static/export/ — fully self-contained, no CSS variables.
# ---------------------------------------------------------------------------
_EXPORT_CSS_DIR = Path(__file__).resolve().parent / "static" / "export"

# Valid export style presets (None = base only)
EXPORT_STYLES = {"minimal", "technical"}

def _get_export_css() -> str:
    """Read base.css from disk (cached after first call)."""
    if not hasattr(_get_export_css, "_cache"):
        path = _EXPORT_CSS_DIR / "base.css"
        try:
            _get_export_css._cache = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            logger.warning("Export CSS file not found: %s", path)
            _get_export_css._cache = ""
    return _get_export_css._cache


def _get_style_css(style: str | None) -> str:
    """Read an export style overlay CSS file (cached per style)."""
    if not style or style not in EXPORT_STYLES:
        return ""
    cache_attr = f"_cache_{style}"
    if not hasattr(_get_style_css, cache_attr):
        path = _EXPORT_CSS_DIR / f"{style}.css"
        try:
            setattr(_get_style_css, cache_attr, path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            logger.warning("Export style CSS not found: %s", path)
            setattr(_get_style_css, cache_attr, "")
    return getattr(_get_style_css, cache_attr)


def _style_block(style: str | None = None) -> str:
    """Return a <style> element with the export CSS + optional style overlay, or empty string."""
    base = _get_export_css().strip()
    overlay = _get_style_css(style).strip()
    css = base
    if overlay:
        css = f"{css}\n\n/* ── Style: {style} ── */\n{overlay}" if css else overlay
    if not css:
        return ""
    return f"<style>\n{css}\n</style>"


def _extra_css_block(density: str = "comfortable", numbering: str = "none") -> str:
    """Return a <style> element with density and numbering overrides, or empty string."""
    parts: list[str] = []

    if density == "compact":
        parts.append("""\
/* ── Density: compact ── */
body { line-height: 1.2; }
p { margin-bottom: 0.25rem; }
h1, h2, h3, h4, h5, h6 { margin-top: 0.5rem; margin-bottom: 0.2rem; }
li { margin: 0; }
ul, ol { margin: 0.1rem 0 0.4em 0; }""")

    if numbering == "none":
        parts.append("""\
/* ── Numbering: none ── */
body { counter-reset: none; }
h2::before, h3::before, h4::before { content: none; counter-increment: none; }""")
    elif numbering == "top-level":
        parts.append("""\
/* ── Numbering: top-level ── */
body { counter-reset: section; }
h2::before { counter-increment: section; content: counter(section) ". "; }
h3::before, h4::before { content: none; counter-increment: none; }""")
    elif numbering == "hierarchical":
        parts.append("""\
/* ── Numbering: hierarchical ── */
body { counter-reset: h2c; }
h2 { counter-reset: h3c; }
h3 { counter-reset: h4c; }
h2::before { counter-increment: h2c; content: counter(h2c) ". "; }
h3::before { counter-increment: h3c; content: counter(h2c) "." counter(h3c) " "; }
h4::before { counter-increment: h4c; content: counter(h2c) "." counter(h3c) "." counter(h4c) " "; }""")

    if not parts:
        return ""
    return f"<style>\n{chr(10).join(parts)}\n</style>"


def _export_to_html(
    nodes: List[Dict],
    resolver=None,
    layout: str = "outline",
    formatting: bool = True,
    style: str | None = None,
    properties_data: Dict[str, list] | None = None,
    density: str = "comfortable",
    numbering: str = "none",
) -> str:
    """Convert nodes to HTML format.
    
    Args:
        nodes: List of node dicts with 'name', '_ast', and 'depth' keys
        resolver: Optional node link resolver
        layout: 'outline' (indented hierarchy) or 'flat' (top node as h1)
        properties_data: Optional dict mapping node UUID to list of property dicts
        
    Returns:
        HTML document string
    """
    import html as html_mod

    _props = properties_data or {}

    def _id_attr(node: Dict) -> str:
        """Return an id attribute for anchor targeting, or empty string."""
        uuid = node.get('uuid', '')
        return f' id="{html_mod.escape(uuid)}"' if uuid else ''

    def _render(node: Dict) -> str:
        """Stringify with PLAIN_MARKDOWN and convert inline syntax to HTML."""
        if formatting:
            return _markdown_inline_to_html(_stringify_node(node, StringifyMode.PLAIN_MARKDOWN, resolver, html_anchors=True))
        return html_mod.escape(_stringify_node(node, StringifyMode.TEXT_ONLY, resolver))

    def _title(node: Dict) -> str:
        """Plain-text title for <title> tag (no formatting)."""
        return _stringify_node(node, StringifyMode.TEXT_ONLY, resolver)

    def _color_attr(node: Dict) -> str:
        """Return a style attribute for colored nodes, or empty string."""
        color = node.get('color')
        if not color:
            return ''
        return f' style="color: {html_mod.escape(color)}"'

    def _render_properties(node: Dict) -> str:
        """Render a properties <dl> block for a page node, or empty string."""
        uuid = node.get('uuid', '')
        props = _props.get(uuid)
        if not props:
            return ''
        items = []
        for p in props:
            name = html_mod.escape(p['name'])
            icon_html = f'<span class="node-property-icon">{html_mod.escape(p["icon"])}</span> ' if p.get('icon') else ''
            if p['values']:
                vals_html = ''.join(f'<dd>{html_mod.escape(v)}</dd>' for v in p['values'])
            else:
                vals_html = '<dd class="node-property-empty">—</dd>'
            items.append(f'<div class="node-property"><dt>{icon_html}{name}</dt>{vals_html}</div>')
        return f'<dl class="node-properties">{chr(10).join(items)}</dl>'

    if not nodes:
        sb = _style_block(style)
        extra = _extra_css_block(density, numbering)
        head_extra = (f"\n{sb}" if sb else "") + (f"\n{extra}" if extra else "")
        return f"<!DOCTYPE html>\n<html><head><title>Notees Export</title>{head_extra}</head><body></body></html>"

    if layout == "flat":
        lines = []
        for node in nodes:
            rendered = _render(node)
            depth = node.get('depth', 0)
            is_page = node.get('is_page', False)
            if is_page:
                level = min(depth + 1, 6)
                lines.append(f"  <h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>")
                props_html = _render_properties(node)
                if props_html:
                    lines.append(f"  {props_html}")
            else:
                lines.append(f"  <p{_id_attr(node)}{_color_attr(node)}>{rendered}</p>")
        title = _title(nodes[0]) if nodes[0].get('is_page') else "Notees Export"
        sb = _style_block(style)
        extra = _extra_css_block(density, numbering)
        head_style = (f"\n{sb}" if sb else "") + (f"\n{extra}" if extra else "")
        return f"""<!DOCTYPE html>
<html>
<head>
<title>{html_mod.escape(title)}</title>{head_style}
</head>
<body>
{chr(10).join(lines)}
</body>
</html>"""

    # outline (default) — nested <ul> based on depth; page nodes break out as headings
    lines = []
    current_depth = -1
    for node in nodes:
        rendered = _render(node)
        depth = node.get('depth', 0)
        is_page = node.get('is_page', False)

        if is_page:
            # Close all open lists before emitting the heading
            while current_depth >= 0:
                lines.append('  ' * current_depth + '</ul>')
                current_depth -= 1
            level = min(depth + 1, 6)
            indent = '  ' * depth
            lines.append(f"{indent}<h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>")
            props_html = _render_properties(node)
            if props_html:
                lines.append(f"{indent}{props_html}")
            # Children of this heading live at depth+1; treat this depth as the new baseline
            current_depth = depth
        else:
            if depth > current_depth:
                for _ in range(depth - current_depth):
                    indent = '  ' * (current_depth + 1)
                    lines.append(f"{indent}<ul>")
                    current_depth += 1
            elif depth < current_depth:
                for _ in range(current_depth - depth):
                    indent = '  ' * current_depth
                    lines.append(f"{indent}</ul>")
                    current_depth -= 1
            indent = '  ' * (depth + 1)
            lines.append(f"{indent}<li{_id_attr(node)}{_color_attr(node)}>{rendered}</li>")
    # Close remaining open lists
    while current_depth >= 0:
        indent = '  ' * current_depth
        lines.append(f"{indent}</ul>")
        current_depth -= 1

    sb = _style_block(style)
    extra = _extra_css_block(density, numbering)
    head_style = (f"\n{sb}" if sb else "") + (f"\n{extra}" if extra else "")
    return f"""<!DOCTYPE html>
<html>
<head>
<title>Notees Export</title>{head_style}
</head>
<body>
{chr(10).join(lines)}
</body>
</html>"""


def get_export_dir(user_id: str, workspace_name: str = "default") -> Path:
    """Get the export directory for a user's workspace.
    
    Args:
        user_id: User ID
        workspace_name: Workspace name (defaults to "default")
        
    Returns:
        Path to export directory (creates if needed)
    """
    export_dir = DATA_DIR / "users" / user_id / "export" / workspace_name
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir

