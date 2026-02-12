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
from .db.schema.init import seed_workspace

logger = get_logger(__name__)

# Track active workspace per user (in-memory, for session)
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


def get_active_workspace_name(user_id: str) -> Optional[str]:
    """Get the active workspace name for a user.
    
    Args:
        user_id: User ID
        
    Returns:
        Active workspace name or None
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
        
        # Set as active if user has no active workspace
        if user_id not in _active_workspaces:
            _active_workspaces[user_id] = name
        
        return result


async def switch_workspace(user_id: str, name: str) -> bool:
    """Switch to a different workspace.
    
    Args:
        user_id: User ID
        name: Workspace name to switch to
        
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
            WHERE g.name = $1 AND g.active = TRUE 
              AND (g.create_uid = $2 OR gs.user_id = $2)
            """,
            name, numeric_user_id
        )
        
        if not workspace:
            return False
        
        _active_workspaces[user_id] = name
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
    
    Exports all nodes, links, and properties in the workspace.
    
    Args:
        user_id: User ID
        name: Workspace name to export
        
    Returns:
        Path to the exported JSON file
        
    Raises:
        ValueError: If user or workspace not found
    """
    import json
    
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")
    
    async with get_connection() as conn:
        # Find workspace
        workspace = await conn.fetchrow(
            """
            SELECT g.id, g.uuid, g.name 
            FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.name = $2 AND g.active = TRUE
              AND (g.create_uid = $1 OR gs.user_id = $1)
            """,
            numeric_user_id, name
        )
        if not workspace:
            raise ValueError(f"Workspace '{name}' not found")
        
        workspace_id = workspace['id']
        
        # Fetch nodes
        nodes = await conn.fetch(
            """
            SELECT uuid, name, icon, color, parent_id, page_id, sequence,
                   collapsed, active, version, is_class, is_page, is_day,
                   is_month, is_year, is_asset, is_template, is_comment,
                   classes_path, open_date, create_date, write_date
            FROM node WHERE workspace_id = $1
            """,
            workspace_id
        )
        
        # Fetch links
        links = await conn.fetch(
            """
            SELECT nl.uuid, nl.source_id, nl.target_id, nl.is_tag, nl.position
            FROM node_link nl
            WHERE nl.workspace_id = $1
            """,
            workspace_id
        )
        
        # Fetch properties
        properties = await conn.fetch(
            """
            SELECT uuid, name, icon, type, is_multi, is_system
            FROM property WHERE workspace_id = $1 OR workspace_id IS NULL
            """,
            workspace_id
        )
        
        export_data = {
            "version": 2,
            "workspace": {"uuid": str(workspace['uuid']), "name": workspace['name']},
            "nodes": [dict(row) for row in nodes],
            "links": [dict(row) for row in links],
            "properties": [dict(row) for row in properties],
        }
        
        # Create export directory
        export_dir = DATA_DIR / "users" / user_id / "export"
        export_dir.mkdir(parents=True, exist_ok=True)
        export_path = export_dir / f"{name}_export.json"
        
        with open(export_path, 'w') as f:
            json.dump(export_data, f, default=str, indent=2)
        
        return export_path


async def import_workspace(user_id: str, file_path: Path, name: str) -> Dict[str, Any]:
    """Import a workspace from a JSON file.
    
    Currently creates an empty workspace - full import not implemented.
    
    Args:
        user_id: User ID
        file_path: Path to import file
        name: Name for the new workspace
        
    Returns:
        Dict with new workspace info
    """
    logger.warning(f"Import not fully implemented - creating empty workspace '{name}'")
    return await create_workspace(user_id, name)


async def export_nodes(
    user_id: str,
    node_ids: List[str],
    format: Any,  # ExportFormat enum
    include_children: bool = True
) -> tuple:
    """Export nodes to various formats.
    
    Args:
        user_id: User ID
        node_ids: List of node UUIDs to export
        format: Export format (markdown, html, pdf)
        include_children: Whether to include child nodes
    
    Returns:
        Tuple of (content: bytes, filename: str, mime_type: str)
        
    Raises:
        ValueError: If user not found or no nodes found
    """
    from .models import ExportFormat
    
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")
    
    # Get user's active workspace
    workspace_name = _active_workspaces.get(user_id)
    
    async with get_connection() as conn:
        # Find workspace
        if workspace_name:
            workspace = await conn.fetchrow(
                """
                SELECT g.id FROM workspace g
                WHERE g.create_uid = $1 AND g.name = $2 AND g.active = TRUE
                """,
                numeric_user_id, workspace_name
            )
        else:
            # Use first available workspace
            workspace = await conn.fetchrow(
                """
                SELECT g.id FROM workspace g
                WHERE g.create_uid = $1 AND g.active = TRUE
                ORDER BY g.create_date LIMIT 1
                """,
                numeric_user_id
            )
        
        if not workspace:
            raise ValueError("No workspace found")
        
        workspace_id = workspace['id']
        
        # Fetch nodes
        nodes_data = []
        for node_uuid in node_ids:
            if include_children:
                # Get node and all descendants using closure table (node_path)
                rows = await conn.fetch(
                    """
                    SELECT n.id, n.uuid, n.name, n.parent_id, np.depth
                    FROM node n
                    JOIN node_path np ON np.descendant_id = n.id
                    WHERE n.workspace_id = $1 
                      AND np.ancestor_id = (SELECT id FROM node WHERE workspace_id = $1 AND uuid::text = $2)
                    ORDER BY np.depth, n.id
                    """,
                    workspace_id, node_uuid
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT id, uuid, name, parent_id 
                    FROM node 
                    WHERE workspace_id = $1 AND uuid::text = $2
                    """,
                    workspace_id, node_uuid
                )
            
            for row in rows:
                nodes_data.append({
                    "uuid": str(row['uuid']),
                    "name": row['name'],
                })
    
    if not nodes_data:
        raise ValueError("No nodes found to export")
    
    # Generate content based on format
    if format == ExportFormat.MARKDOWN or format == "markdown":
        content = _export_to_markdown(nodes_data)
        filename = "export.md"
        mime_type = "text/markdown"
    elif format == ExportFormat.HTML or format == "html":
        content = _export_to_html(nodes_data)
        filename = "export.html"
        mime_type = "text/html"
    elif format == ExportFormat.PDF or format == "pdf":
        # PDF export not fully implemented - return HTML
        content = _export_to_html(nodes_data)
        filename = "export.html"
        mime_type = "text/html"
    else:
        raise ValueError(f"Unsupported format: {format}")
    
    return content.encode('utf-8'), filename, mime_type


def _export_to_markdown(nodes: List[Dict]) -> str:
    """Convert nodes to Markdown format.
    
    Args:
        nodes: List of node dicts with 'name' key
        
    Returns:
        Markdown string with nodes as list items
    """
    lines = []
    for node in nodes:
        name = node.get('name', '')
        lines.append(f"- {name}")
    return "\n".join(lines)


def _export_to_html(nodes: List[Dict]) -> str:
    """Convert nodes to HTML format.
    
    Args:
        nodes: List of node dicts with 'name' key
        
    Returns:
        HTML document string
    """
    items = []
    for node in nodes:
        name = node.get('name', '')
        items.append(f"  <li>{name}</li>")
    
    return f"""<!DOCTYPE html>
<html>
<head><title>Notees Export</title></head>
<body>
<ul>
{chr(10).join(items)}
</ul>
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


# ============== Backward Compatibility Aliases ==============

# Keep old function names for backward compatibility
list_databases = list_workspaces
get_active_db_name = get_active_workspace_name
create_database = create_workspace
switch_database = switch_workspace
rename_database = rename_workspace
delete_database = delete_workspace
export_database = export_workspace
import_database = import_workspace


