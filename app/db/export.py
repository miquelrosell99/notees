"""Export operations for nodes and pages."""
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..logging_config import logger
from ..models import ExportFormat
from .connection import get_db, get_active_db_name, get_user_data_dir

SYSTEM_TAG_PAGE = '00000000-0000-0000-0000-000000000001'


# Stub functions for node operations - to be replaced with repository calls
async def get_node(user_id: str, node_id: str) -> Optional[Dict[str, Any]]:
    """Get a single node by ID. Stub function."""
    db = await get_db(user_id)
    cursor = db.execute(
        "SELECT * FROM node WHERE id = ? OR uuid = ?",
        (node_id, node_id)
    )
    row = cursor.fetchone()
    if row:
        return dict(row)
    return None


async def get_child_nodes(user_id: str, parent_id: int) -> List[Dict[str, Any]]:
    """Get all child nodes of a parent. Stub function."""
    db = await get_db(user_id)
    cursor = db.execute(
        "SELECT * FROM node WHERE parent_id = ? ORDER BY sequence",
        (parent_id,)
    )
    return [dict(row) for row in cursor.fetchall()]


async def get_all_pages(user_id: str) -> List[Dict[str, Any]]:
    """Get all pages. Uses is_page column for efficient filtering."""
    db = await get_db(user_id)
    # Get pages using is_page column
    cursor = db.execute(
        """
        SELECT * FROM node
        WHERE is_page = 1 AND active = 1
        ORDER BY name
        """
    )
    return [dict(row) for row in cursor.fetchall()]


async def get_node_tree(user_id: str, node_id: str, max_depth: int = 10) -> Optional[Dict[str, Any]]:
    """Get a node with its full tree for export."""
    node = await get_node(user_id, node_id)
    if not node:
        return None
    
    async def build_tree(n: Dict, depth: int = 0) -> Dict:
        if depth >= max_depth:
            return n
        
        children = await get_child_nodes(user_id, n["id"])
        n["children"] = []
        for child in children:
            n["children"].append(await build_tree(child, depth + 1))
        return n
    
    return await build_tree(node)


def _node_to_markdown(node: Dict, level: int = 0) -> str:
    """Convert a node tree to Markdown."""
    lines = []
    indent = "  " * level
    
    # Check if page via system tag
    tags = node.get("tags", [])
    is_page = SYSTEM_TAG_PAGE in tags
    
    if is_page:
        if level == 0:
            lines.append(f"# {node.get('name', 'Untitled')}\n")
        else:
            lines.append(f"{indent}- [[{node.get('name', 'Untitled')}]]")
    else:
        bullet = "-" if level == 0 else "-"
        content = node.get("name") or ""
        lines.append(f"{indent}{bullet} {content}")
    
    for child in node.get("children", []):
        lines.append(_node_to_markdown(child, level + 1))
    
    return "\n".join(lines)


def _node_to_html(node: Dict, level: int = 0) -> str:
    """Convert a node tree to HTML."""
    
    def format_content(content: str) -> str:
        """Format content with links and formatting."""
        # Wiki links
        content = re.sub(r'\[\[([^\]]+)\]\]', r'<a href="#\1" class="wiki-link">\1</a>', content)
        # Block refs
        content = re.sub(r'\(\(([a-zA-Z0-9-]+)\)\)', r'<span class="block-ref" data-id="\1">\1</span>', content)
        # Bold
        content = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', content)
        # Italic
        content = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', content)
        # Code
        content = re.sub(r'`([^`]+)`', r'<code>\1</code>', content)
        return content
    
    html_parts = []
    
    tags = node.get("tags", [])
    is_page = SYSTEM_TAG_PAGE in tags
    
    if is_page and level == 0:
        html_parts.append(f"<h1>{node.get('name', 'Untitled')}</h1>")
    else:
        content = format_content(node.get("name") or "")
        html_parts.append(f"<li>{content}")
    
    children = node.get("children", [])
    if children:
        html_parts.append("<ul>")
        for child in children:
            html_parts.append(_node_to_html(child, level + 1))
        html_parts.append("</ul>")
    
    if level > 0 or not node.get("is_page", False):
        html_parts.append("</li>")
    
    return "\n".join(html_parts)


async def export_nodes(
    user_id: str,
    node_ids: List[str],
    format: ExportFormat,
    include_children: bool = True
) -> Tuple[str, str, str]:
    """Export nodes to the specified format.
    
    Returns: (content, filename, mime_type)
    """
    nodes = []
    for node_id in node_ids:
        if include_children:
            node = await get_node_tree(user_id, node_id)
        else:
            node = await get_node(user_id, node_id)
            if node:
                node["children"] = []
        if node:
            nodes.append(node)
    
    if not nodes:
        raise ValueError("No nodes found")
    
    # Generate filename based on first node
    base_name = re.sub(r'[^\w\-]', '_', nodes[0].get("name") or nodes[0]["id"])[:50]
    timestamp = datetime.now().strftime("%Y%m%d")
    
    if format == ExportFormat.MARKDOWN:
        content = "\n\n---\n\n".join(_node_to_markdown(n) for n in nodes)
        return content, f"{base_name}_{timestamp}.md", "text/markdown"
    
    elif format == ExportFormat.HTML:
        html_content = "\n".join(_node_to_html(n) for n in nodes)
        full_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{nodes[0].get('name') or 'Export'}</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
               max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }}
        h1 {{ border-bottom: 2px solid #eee; padding-bottom: 10px; }}
        ul {{ list-style-type: disc; padding-left: 24px; }}
        li {{ margin: 4px 0; }}
        .wiki-link {{ color: #4263eb; text-decoration: none; }}
        .wiki-link:hover {{ text-decoration: underline; }}
        .block-ref {{ background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }}
        code {{ background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-family: monospace; }}
        strong {{ font-weight: 600; }}
    </style>
</head>
<body>
    {html_content}
</body>
</html>"""
        return full_html, f"{base_name}_{timestamp}.html", "text/html"
    
    elif format == ExportFormat.PDF:
        # For PDF, we generate HTML that can be converted client-side or via a library
        # Return HTML with print-friendly styles
        html_content = "\n".join(_node_to_html(n) for n in nodes)
        pdf_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>{nodes[0].get('name') or 'Export'}</title>
    <style>
        @page {{ margin: 2cm; }}
        body {{ font-family: Georgia, serif; font-size: 12pt; line-height: 1.5; }}
        h1 {{ font-size: 18pt; margin-bottom: 20px; }}
        ul {{ padding-left: 20px; }}
        li {{ margin: 4px 0; }}
        .wiki-link {{ color: #333; font-weight: 500; }}
        code {{ font-family: 'Courier New', monospace; font-size: 10pt; }}
    </style>
</head>
<body>
    {html_content}
</body>
</html>"""
        return pdf_html, f"{base_name}_{timestamp}.html", "text/html"
    
    raise ValueError(f"Unsupported format: {format}")


async def auto_export_page_to_markdown(user_id: str, page: Dict[str, Any]) -> Optional[Path]:
    """Auto-export a page to markdown in the export directory."""
    try:
        db_name = get_active_db_name(user_id)
        if not db_name:
            return None
        
        export_dir = get_user_data_dir(user_id) / "export" / db_name
        export_dir.mkdir(parents=True, exist_ok=True)
        
        # Get full tree
        full_page = await get_node_tree(user_id, page["id"])
        if not full_page:
            return None
        
        # Convert to markdown
        content = _node_to_markdown(full_page)
        
        # Create filename from title/name
        title = page.get("title") or page.get("name") or page.get("content") or page["id"]
        safe_title = re.sub(r'[^\w\-]', '_', title)[:100]
        file_path = export_dir / f"{safe_title}.md"
        
        # Write file
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        return file_path
    except Exception as e:
        logger.error(f"Auto-export error: {e}")
        return None


async def export_all_pages_to_markdown(user_id: str) -> List[Path]:
    """Export all pages to markdown."""
    pages = await get_all_pages(user_id)
    exported = []
    for page in pages:
        path = await auto_export_page_to_markdown(user_id, page)
        if path:
            exported.append(path)
    return exported
