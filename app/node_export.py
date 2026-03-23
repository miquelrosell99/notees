"""Node export service for Notees.

Handles exporting nodes to Markdown, HTML, and PDF formats, with support for
properties, tags, classes, and text property subtrees.
"""
from pathlib import Path
from typing import Optional, Dict, List, Any

from .logging_config import get_logger
from .db.connection import get_connection, DATA_DIR
from .db.schema.init import get_or_create_user_workspace
from .domain.stringify_ast import (
    parse_ast,
    stringify_ast,
    StringifyMode,
    StringifyOptions,
    NodeLinkResolution,
)
from .workspace_manager import _get_numeric_user_id, _active_workspaces

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Export stylesheet constants
# ---------------------------------------------------------------------------
_EXPORT_CSS_DIR = Path(__file__).resolve().parent / "static" / "export"

EXPORT_THEMES    = {"minimal", "technical", "book"}
EXPORT_DENSITIES = {"comfortable", "compact"}
EXPORT_NUMBERING = {"none", "hierarchical", "legal", "appendix"}
EXPORT_MEASURES  = {"full", "readable", "book", "two-column"}
EXPORT_DOCTYPES  = {"none", "article", "report", "book", "legal", "academic"}

_export_css_cache: str | None = None


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
    numbering: str = "none",  # "none" | "hierarchical" | "legal" | "appendix"
    measure: str = "full",   # "full" | "readable" | "book" | "two-column"
    doctype: str = "none",   # "none" | "article" | "report" | "book" | "legal" | "academic"
    section_break: bool = False,
    show_uuid: bool = False,
    link_style: str = "raw",  # "raw" | "text"
) -> tuple:
    """Export nodes to Markdown, HTML, or PDF.

    Returns:
        Tuple of (content: bytes, filename: str, mime_type: str)

    Raises:
        ValueError: If user not found or no nodes found.
    """
    from .models import ExportFormat

    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")

    active_uuid = _active_workspaces.get(user_id)

    async with get_connection() as conn:
        workspace_id = await get_or_create_user_workspace(conn, numeric_user_id, workspace_uuid=active_uuid)

        nodes_data = []
        seen_uuids: set[str] = set()
        for node_uuid in node_ids:
            if include_children:
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

        # Filter out text property value blocks (post-query safety net)
        if include_children and len(nodes_data) > 1:
            all_tree_ids = [nd['id'] for nd in nodes_data]
            text_prop_rows = await conn.fetch("""
                SELECT DISTINCT pvr.target_id
                FROM property_value_relation pvr
                JOIN property p ON p.id = pvr.property_id
                WHERE pvr.target_id = ANY($1)
                  AND p.type = 'text'
            """, all_tree_ids)
            text_prop_ids = {r['target_id'] for r in text_prop_rows}
            if text_prop_ids:
                filtered: list[dict] = []
                skip_depth: int | None = None
                for nd in nodes_data:
                    if skip_depth is not None:
                        if nd['depth'] > skip_depth:
                            continue
                        else:
                            skip_depth = None
                    if nd['id'] in text_prop_ids:
                        skip_depth = nd['depth']
                        continue
                    filtered.append(nd)
                nodes_data = filtered

        # Resolve node links in all ASTs
        target_uuids: set[str] = set()
        for nd in nodes_data:
            ast = parse_ast(nd['name'])
            nd['_ast'] = ast
            _collect_link_target_uuids(ast, target_uuids)

        link_target_map: Dict[str, list] = {}
        link_is_page_map: Dict[str, bool] = {}
        if target_uuids:
            placeholders = ', '.join(f'${i+2}' for i in range(len(target_uuids)))
            target_rows = await conn.fetch(
                f"SELECT uuid, name, is_page FROM node WHERE workspace_id = $1 AND uuid::text IN ({placeholders})",
                workspace_id, *list(target_uuids)
            )
            for tr in target_rows:
                link_target_map[str(tr['uuid'])] = parse_ast(tr['name'])
                link_is_page_map[str(tr['uuid'])] = bool(tr['is_page'])

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
                is_page=link_is_page_map.get(node_uuid),
            )

        # Fetch properties for page nodes if requested
        properties_data: Dict[str, list] = {}
        if properties in ("main", "all"):
            target_nodes = [nd for nd in nodes_data if nd.get('depth', 0) == 0] if properties == "main" else nodes_data
            page_node_ids = [nd['id'] for nd in target_nodes if nd.get('id')]
            if page_node_ids:
                prop_rows = await conn.fetch(
                    """
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
                    ORDER BY np.node_id, p.name
                    """,
                    page_node_ids
                )
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
                    elif prop_type == 'node' and row['relation_target_id'] is not None:
                        value_str = relation_target_names.get(row['relation_target_id'])
                    elif prop_type == 'text' and row['relation_target_id'] is not None:
                        value_str = relation_target_names.get(row['relation_target_id'])
                        if 'target_ids' not in entry:
                            entry['target_ids'] = []
                        tid = row['relation_target_id']
                        if tid not in entry['target_ids']:
                            entry['target_ids'].append(tid)
                    elif prop_type == 'selection' and row['selection_value'] is not None:
                        value_str = row['selection_value']
                    if value_str is not None and value_str not in entry['values']:
                        entry['values'].append(value_str)

                # Classes
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

                # Tags
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

                # Text property subtrees
                all_text_target_ids = [
                    tid
                    for props in agg.values()
                    for pe in props.values()
                    if pe['type'] == 'text' and 'target_ids' in pe
                    for tid in pe['target_ids']
                ]
                text_subtrees: Dict[int, List[Dict]] = {}
                if all_text_target_ids:
                    sub_rows = await conn.fetch("""
                        WITH RECURSIVE sub AS (
                            SELECT n.id, n.uuid::text as uuid, n.name, n.color,
                                   0 AS rel_depth, n.id AS root_id,
                                   ARRAY[n.sequence, n.id] AS path_order
                            FROM node n
                            WHERE n.id = ANY($1)
                              AND n.active = TRUE AND n.is_deleted = FALSE
                            UNION ALL
                            SELECT n.id, n.uuid::text as uuid, n.name, n.color,
                                   s.rel_depth + 1, s.root_id,
                                   s.path_order || ARRAY[n.sequence, n.id]
                            FROM node n
                            JOIN sub s ON n.parent_id = s.id
                            WHERE n.active = TRUE AND n.is_deleted = FALSE
                              AND n.is_page = FALSE
                        )
                        SELECT id, uuid, name, color, rel_depth, root_id
                        FROM sub ORDER BY root_id, path_order
                    """, all_text_target_ids)
                    for sr in sub_rows:
                        rid = sr['root_id']
                        if rid not in text_subtrees:
                            text_subtrees[rid] = []
                        text_subtrees[rid].append({
                            'uuid': sr['uuid'],
                            'name': sr['name'],
                            '_ast': parse_ast(sr['name']),
                            'depth': sr['rel_depth'],
                            'color': sr.get('color'),
                            'is_page': False,
                        })
                    subtree_link_uuids: set[str] = set()
                    for nd_list in text_subtrees.values():
                        for nd in nd_list:
                            _collect_link_target_uuids(nd['_ast'], subtree_link_uuids)
                    new_uuids = subtree_link_uuids - set(link_target_map.keys())
                    if new_uuids:
                        placeholders2 = ', '.join(f'${i+2}' for i in range(len(new_uuids)))
                        extra_rows = await conn.fetch(
                            f"SELECT uuid, name, is_page FROM node WHERE workspace_id = $1 AND uuid::text IN ({placeholders2})",
                            workspace_id, *list(new_uuids)
                        )
                        for er in extra_rows:
                            link_target_map[str(er['uuid'])] = parse_ast(er['name'])
                            link_is_page_map[str(er['uuid'])] = bool(er['is_page'])
                for props in agg.values():
                    for pe in props.values():
                        if pe['type'] == 'text' and 'target_ids' in pe:
                            pe['subtree'] = []
                            for tid in pe['target_ids']:
                                pe['subtree'].extend(text_subtrees.get(tid, []))

                for node_uuid_key, props in agg.items():
                    pinned = [p for p in props.values() if p['type'] in ('classes', 'tags')]
                    rest = sorted(
                        [p for p in props.values() if p['type'] not in ('classes', 'tags')],
                        key=lambda p: p['name']
                    )
                    properties_data[node_uuid_key] = pinned + rest

    if show_uuid and properties != "none":
        for nd in nodes_data:
            uuid_val = nd.get('uuid', '')
            if not uuid_val:
                continue
            if nd.get('depth', 0) == 0 or properties == "all":
                uuid_prop = {'name': 'uuid', 'icon': None, 'type': 'text', 'values': [uuid_val]}
                existing = properties_data.get(uuid_val, [])
                properties_data[uuid_val] = [uuid_prop] + [p for p in existing if p['name'] != 'uuid']

    strip_links = link_style == "text"

    if format == ExportFormat.MARKDOWN or format == "markdown":
        content = _export_to_markdown(nodes_data, resolve_node_link, layout, formatting, properties_data, strip_link_syntax=strip_links)
        filename = "export.md"
        mime_type = "text/markdown"
    elif format == ExportFormat.HTML or format == "html":
        content = _export_to_html(nodes_data, resolve_node_link, layout, formatting, style, properties_data, density, numbering, measure, doctype, section_break, strip_link_syntax=strip_links)
        filename = "export.html"
        mime_type = "text/html"
    elif format == ExportFormat.PDF or format == "pdf":
        html_content = _export_to_html(nodes_data, resolve_node_link, layout, formatting, style, properties_data, density, numbering, measure, doctype, section_break, strip_link_syntax=strip_links)
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


def get_export_dir(user_id: str, workspace_name: str = "default") -> Path:
    """Get (and create) the export directory for a user's workspace."""
    export_dir = DATA_DIR / "users" / user_id / "export" / workspace_name
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

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
        children = node.get('children')
        if children:
            _collect_link_target_uuids(children, out)


def _is_heading_node(node_data: Dict) -> bool:
    """Return True if the node's first AST block has type 'heading'."""
    ast = node_data.get('_ast') or parse_ast(node_data.get('name', ''))
    return bool(ast and isinstance(ast, list) and ast[0].get('type') == 'heading')


def _stringify_node(node_data: Dict, mode: StringifyMode, resolver, html_anchors: bool = False, strip_link_syntax: bool = False) -> str:
    """Stringify a single node's AST to text."""
    ast = node_data.get('_ast') or parse_ast(node_data.get('name', ''))
    opts = StringifyOptions(mode=mode, resolve_node_link=resolver, html_anchors=html_anchors, strip_link_syntax=strip_link_syntax)
    return stringify_ast(ast, opts)


def _markdown_inline_to_html(md: str) -> str:
    """Convert PLAIN_MARKDOWN inline syntax to HTML with proper escaping.

    Tokenises the string produced by stringify_ast(PLAIN_MARKDOWN) so that:
    - User-typed text segments are HTML-escaped.
    - Markdown formatting tokens are translated to the matching HTML element.
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
                href = lm.group(2)
                link_text = lm.group(1)
                if href.startswith('#'):
                    result.append(f'<a href="{_html.escape(href)}" class="node-link">{_html.escape(link_text)}</a>')
                else:
                    result.append(f'<a href="{_html.escape(href)}" class="url-link">{_html.escape(link_text)}</a>')
            else:
                result.append(_html.escape(token))
        last = m.end()
    if last < len(md):
        result.append(_html.escape(md[last:]))
    return ''.join(result)


def _get_export_css_single() -> str:
    """Read and cache the layered export CSS from layers/ directory."""
    global _export_css_cache
    if _export_css_cache is None:
        layers_dir = _EXPORT_CSS_DIR / "layers"
        parts: list[str] = []
        for layer_path in sorted(layers_dir.glob("*.css")):
            try:
                parts.append(layer_path.read_text(encoding="utf-8"))
            except Exception as exc:
                logger.warning("Failed to read export CSS layer %s: %s", layer_path, exc)
        if not parts:
            logger.warning("No export CSS layers found in %s", layers_dir)
        _export_css_cache = "\n\n".join(parts)
    return _export_css_cache


def _build_body_class(
    style: str | None,
    layout: str,
    density: str,
    numbering: str,
    measure: str = "full",
    doctype: str = "none",
    section_break: bool = False,
) -> str:
    """Return the body class string encoding all render axes."""
    theme     = style if style in EXPORT_THEMES else "minimal"
    structure = "flat" if layout == "flat" else "indented"
    dens      = density if density in EXPORT_DENSITIES else "comfortable"
    num       = numbering if numbering in EXPORT_NUMBERING else "none"
    msr       = measure if measure in EXPORT_MEASURES else "full"
    dt        = doctype if doctype in EXPORT_DOCTYPES and doctype != "none" else ""
    classes   = f"theme-{theme} structure-{structure} density-{dens} numbering-{num} layout-{msr}"
    if dt:
        classes += f" doctype-{dt}"
    if section_break:
        classes += " section-break-before"
    return classes


def _html_style_tag() -> str:
    """Return a <style> element containing the full export CSS, or empty string."""
    css = _get_export_css_single().strip()
    return f"<style>\n{css}\n</style>" if css else ""


def _export_to_markdown(
    nodes: List[Dict],
    resolver=None,
    layout: str = "outline",
    formatting: bool = True,
    properties_data: Dict[str, list] | None = None,
    strip_link_syntax: bool = False,
) -> str:
    """Convert nodes to Markdown format."""
    if not nodes:
        return ""

    _props = properties_data or {}
    lines = []
    for node in nodes:
        text = _stringify_node(node, StringifyMode.PLAIN_MARKDOWN, resolver, strip_link_syntax=strip_link_syntax)
        depth = node.get('depth', 0)
        is_page = node.get('is_page', False)

        if formatting and node.get('color'):
            text = f"=={text}=="

        if is_page and layout == "flat":
            hashes = '#' * (depth + 1)
            lines.append(f"{hashes} {text}")
            props = _props.get(node.get('uuid', ''), [])
            for p in props:
                if p.get('subtree'):
                    lines.append(f"{p['name']}::")
                    for sub_nd in p['subtree']:
                        sub_text = _stringify_node(sub_nd, StringifyMode.PLAIN_MARKDOWN, resolver, strip_link_syntax=strip_link_syntax)
                        if formatting and sub_nd.get('color'):
                            sub_text = f"=={sub_text}=="
                        sub_depth = sub_nd.get('depth', 0)
                        sub_indent = '  ' * (sub_depth + 1)
                        lines.append(f"{sub_indent}- {sub_text}")
                elif p['values']:
                    lines.append(f"{p['name']}:: {', '.join(p['values'])}")
                else:
                    lines.append(f"{p['name']}::")
        elif layout == "flat":
            is_heading = _is_heading_node(node)
            if is_heading:
                hashes = '#' * min(depth + 1, 6)
                lines.append(f"{hashes} {text}")
            else:
                lines.append(text)
            props = _props.get(node.get('uuid', ''), [])
            for p in props:
                if p.get('subtree'):
                    lines.append(f"{p['name']}::")
                    for sub_nd in p['subtree']:
                        sub_text = _stringify_node(sub_nd, StringifyMode.PLAIN_MARKDOWN, resolver, strip_link_syntax=strip_link_syntax)
                        if formatting and sub_nd.get('color'):
                            sub_text = f"=={sub_text}=="
                        sub_depth = sub_nd.get('depth', 0)
                        sub_indent = '  ' * (sub_depth + 1)
                        lines.append(f"{sub_indent}- {sub_text}")
                elif p['values']:
                    lines.append(f"{p['name']}:: {', '.join(p['values'])}")
                else:
                    lines.append(f"{p['name']}::")
        else:
            # outline
            is_heading = _is_heading_node(node)
            if is_heading:
                hashes = '#' * min(depth + 1, 6)
                lines.append(f"{hashes} {text}")
            else:
                indent = '  ' * depth
                lines.append(f"{indent}- {text}")
            indent = '  ' * depth
            props = _props.get(node.get('uuid', ''), [])
            for p in props:
                if p.get('subtree'):
                    lines.append(f"{indent}  {p['name']}::")
                    for sub_nd in p['subtree']:
                        sub_text = _stringify_node(sub_nd, StringifyMode.PLAIN_MARKDOWN, resolver, strip_link_syntax=strip_link_syntax)
                        if formatting and sub_nd.get('color'):
                            sub_text = f"=={sub_text}=="
                        sub_depth = sub_nd.get('depth', 0)
                        sub_indent = indent + '  ' * (sub_depth + 2)
                        lines.append(f"{sub_indent}- {sub_text}")
                elif p['values']:
                    lines.append(f"{indent}  {p['name']}:: {', '.join(p['values'])}")
                else:
                    lines.append(f"{indent}  {p['name']}::")

    return "\n".join(lines)


def _export_to_html(
    nodes: List[Dict],
    resolver=None,
    layout: str = "outline",
    formatting: bool = True,
    style: str | None = None,
    properties_data: Dict[str, list] | None = None,
    density: str = "comfortable",
    numbering: str = "none",
    measure: str = "full",
    doctype: str = "none",
    section_break: bool = False,
    strip_link_syntax: bool = False,
) -> str:
    """Convert nodes to HTML format."""
    import html as html_mod

    _props = properties_data or {}

    def _id_attr(node: Dict) -> str:
        uuid = node.get('uuid', '')
        return f' id="{html_mod.escape(uuid)}"' if uuid else ''

    def _render(node: Dict) -> str:
        if formatting:
            return _markdown_inline_to_html(_stringify_node(node, StringifyMode.PLAIN_MARKDOWN, resolver, html_anchors=not strip_link_syntax, strip_link_syntax=strip_link_syntax))
        return html_mod.escape(_stringify_node(node, StringifyMode.TEXT_ONLY, resolver))

    def _title(node: Dict) -> str:
        return _stringify_node(node, StringifyMode.TEXT_ONLY, resolver)

    def _color_attr(node: Dict) -> str:
        color = node.get('color')
        if not color:
            return ''
        return f' style="color: {html_mod.escape(color)}"'

    def _render_subtree_html(sub_nodes: List[Dict]) -> str:
        parts: list[str] = []
        current_depth = -1
        for nd in sub_nodes:
            rendered = _render(nd)
            depth = nd.get('depth', 0)
            if depth == 0:
                while current_depth >= 0:
                    parts.append('</ul>')
                    current_depth -= 1
                parts.append(f'<span class="node-property-text">{rendered}</span>')
            else:
                if depth > current_depth:
                    for _ in range(depth - current_depth):
                        parts.append('<ul class="node-property-list">')
                        current_depth += 1
                elif depth < current_depth:
                    for _ in range(current_depth - depth):
                        parts.append('</ul>')
                        current_depth -= 1
                parts.append(f'<li>{rendered}</li>')
        while current_depth >= 0:
            parts.append('</ul>')
            current_depth -= 1
        return '\n'.join(parts)

    def _render_properties(node: Dict) -> str:
        uuid = node.get('uuid', '')
        props = _props.get(uuid)
        if not props:
            return ''
        rows = []
        for p in props:
            name = html_mod.escape(p['name'])
            icon_html = f'<span class="node-property-icon">{html_mod.escape(p["icon"])}</span> ' if p.get('icon') else ''
            if p.get('subtree'):
                val_html = _render_subtree_html(p['subtree'])
            elif p['values']:
                val_html = html_mod.escape(', '.join(p['values']))
            else:
                val_html = '<span class="node-property-empty">—</span>'
            rows.append(f'<tr class="node-property"><td class="node-property-name">{icon_html}{name}</td><td class="node-property-value">{val_html}</td></tr>')
        return f'<table class="node-properties">{chr(10).join(rows)}</table>'

    body_class = _build_body_class(style, layout, density, numbering, measure, doctype, section_break)
    style_tag  = _html_style_tag()
    head_extra = f"\n{style_tag}" if style_tag else ""

    if not nodes:
        return f"<!DOCTYPE html>\n<html><head><title>Notees Export</title>{head_extra}</head><body class=\"{body_class}\"></body></html>"

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
                props_html = _render_properties(node)
                if _is_heading_node(node):
                    level = min(depth + 1, 6)
                    if props_html:
                        lines.append(f"  <h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}{props_html}</h{level}>")
                    else:
                        lines.append(f"  <h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>")
                elif props_html:
                    lines.append(f"  <p{_id_attr(node)}{_color_attr(node)}>{rendered}{props_html}</p>")
                else:
                    lines.append(f"  <p{_id_attr(node)}{_color_attr(node)}>{rendered}</p>")
        title = _title(nodes[0]) if nodes[0].get('is_page') else "Notees Export"
        return f"""<!DOCTYPE html>
<html>
<head>
<title>{html_mod.escape(title)}</title>{head_extra}
</head>
<body class="{body_class}">
{chr(10).join(lines)}
</body>
</html>"""

    # outline — nested <ul> based on depth; page nodes break out as headings
    lines = []
    current_depth = -1
    for node in nodes:
        rendered = _render(node)
        depth = node.get('depth', 0)
        is_page = node.get('is_page', False)

        if is_page:
            while current_depth >= 0:
                lines.append('  ' * current_depth + '</ul>')
                current_depth -= 1
            level = min(depth + 1, 6)
            indent = '  ' * depth
            lines.append(f"{indent}<h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>")
            props_html = _render_properties(node)
            if props_html:
                lines.append(f"{indent}{props_html}")
            current_depth = depth
        else:
            if _is_heading_node(node):
                while current_depth >= 0:
                    lines.append('  ' * current_depth + '</ul>')
                    current_depth -= 1
                level = min(depth + 1, 6)
                indent = '  ' * depth
                lines.append(f"{indent}<h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>")
                props_html = _render_properties(node)
                if props_html:
                    lines.append(f"{indent}{props_html}")
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
                props_html = _render_properties(node)
                if props_html:
                    lines.append(f"{indent}<li class=\"node-block\"{_id_attr(node)}{_color_attr(node)}>{rendered}{props_html}</li>")
                else:
                    lines.append(f"{indent}<li class=\"node-block\"{_id_attr(node)}{_color_attr(node)}>{rendered}</li>")
    while current_depth >= 0:
        indent = '  ' * current_depth
        lines.append(f"{indent}</ul>")
        current_depth -= 1

    return f"""<!DOCTYPE html>
<html>
<head>
<title>Notees Export</title>{head_extra}
</head>
<body class="{body_class}">
{chr(10).join(lines)}
</body>
</html>"""
