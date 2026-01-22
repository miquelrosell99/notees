"""Database operations for Notees - PostgreSQL version.

This module provides minimal backward compatibility stubs.
All node operations are now handled via:
- app/domain/repositories (PostgreSQL implementations)
- app/routers/nodes.py (REST API endpoints)
- app/db/connection.py (connection pooling)
- app/db/schema.py (database schema)

NOTE: Most functions here are stubs that raise NotImplementedError.
Use the repository/router pattern instead.
"""
from pathlib import Path
from typing import Optional, Dict, List, Any

from .config import settings
from .logging_config import get_logger
from .db.connection import get_connection

logger = get_logger(__name__)

# Base data directory for assets (file-based)
DATA_DIR = settings.database_dir

# Legacy task states constant (may still be referenced)
TASK_STATES = ['todo', 'doing', 'done', 'cancelled']

# Track active workspace per user (in-memory, for session)
_active_workspaces: Dict[str, str] = {}


# ============== Workspace/Database Management ==============

async def _get_numeric_user_id(user_id: str) -> Optional[int]:
    """Convert string user_id to numeric PostgreSQL ID."""
    async with get_connection() as conn:
        row = await conn.fetchrow(
            'SELECT id FROM "user" WHERE id::text = $1 OR uuid::text = $1',
            user_id
        )
        return row['id'] if row else None


async def list_databases(user_id: str) -> List[Dict[str, Any]]:
    """List all workspaces for a user."""
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        return []
    
    async with get_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT w.uuid, w.name, w.create_date, w.is_shared
            FROM workspace w
            LEFT JOIN workspace_member wm ON w.id = wm.workspace_id
            WHERE w.owner_id = $1 OR wm.user_id = $1
            ORDER BY w.create_date DESC
            """,
            numeric_user_id
        )
        
        return [
            {
                "uuid": str(row['uuid']),
                "name": row['name'],
                "created_at": row['create_date'].isoformat() if row['create_date'] else None,
                "is_shared": row['is_shared'],
            }
            for row in rows
        ]


def get_active_db_name(user_id: str) -> Optional[str]:
    """Get the active workspace name for a user."""
    return _active_workspaces.get(user_id)


async def create_database(user_id: str, name: str) -> Dict[str, Any]:
    """Create a new workspace for a user."""
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")
    
    async with get_connection() as conn:
        # Check if name already exists
        existing = await conn.fetchrow(
            "SELECT id FROM workspace WHERE owner_id = $1 AND name = $2",
            numeric_user_id, name
        )
        if existing:
            raise ValueError(f"Database '{name}' already exists")
        
        # Create workspace
        row = await conn.fetchrow(
            """
            INSERT INTO workspace (name, owner_id, is_shared)
            VALUES ($1, $2, FALSE)
            RETURNING id, uuid, name, create_date
            """,
            name, numeric_user_id
        )
        
        # Add owner as member
        await conn.execute(
            """
            INSERT INTO workspace_member (workspace_id, user_id, role)
            VALUES ($1, $2, 'owner')
            """,
            row['id'], numeric_user_id
        )
        
        result = {
            "uuid": str(row['uuid']),
            "name": row['name'],
            "created_at": row['create_date'].isoformat() if row['create_date'] else None,
        }
        
        if user_id not in _active_workspaces:
            _active_workspaces[user_id] = name
        
        return result


async def switch_database(user_id: str, name: str) -> bool:
    """Switch to a different workspace."""
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        return False
    
    async with get_connection() as conn:
        workspace = await conn.fetchrow(
            """
            SELECT w.id FROM workspace w
            LEFT JOIN workspace_member wm ON w.id = wm.workspace_id
            WHERE w.name = $1 AND (w.owner_id = $2 OR wm.user_id = $2)
            """,
            name, numeric_user_id
        )
        
        if not workspace:
            return False
        
        _active_workspaces[user_id] = name
        return True


async def rename_database(user_id: str, old_name: str, new_name: str) -> Dict[str, Any]:
    """Rename a workspace."""
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")
    
    async with get_connection() as conn:
        old_workspace = await conn.fetchrow(
            "SELECT id, uuid FROM workspace WHERE owner_id = $1 AND name = $2",
            numeric_user_id, old_name
        )
        if not old_workspace:
            raise ValueError(f"Database '{old_name}' not found")
        
        existing = await conn.fetchrow(
            "SELECT id FROM workspace WHERE owner_id = $1 AND name = $2",
            numeric_user_id, new_name
        )
        if existing:
            raise ValueError(f"Database '{new_name}' already exists")
        
        row = await conn.fetchrow(
            """
            UPDATE workspace SET name = $1, write_date = NOW()
            WHERE id = $2
            RETURNING uuid, name, create_date
            """,
            new_name, old_workspace['id']
        )
        
        if _active_workspaces.get(user_id) == old_name:
            _active_workspaces[user_id] = new_name
        
        return {
            "uuid": str(row['uuid']),
            "name": row['name'],
            "created_at": row['create_date'].isoformat() if row['create_date'] else None,
        }


async def delete_database(user_id: str, name: str) -> bool:
    """Delete a workspace."""
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        return False
    
    async with get_connection() as conn:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM workspace WHERE owner_id = $1",
            numeric_user_id
        )
        if count <= 1:
            raise ValueError("Cannot delete the last database")
        
        result = await conn.execute(
            "DELETE FROM workspace WHERE owner_id = $1 AND name = $2",
            numeric_user_id, name
        )
        
        deleted = result.split()[-1] != '0'
        
        if deleted and _active_workspaces.get(user_id) == name:
            del _active_workspaces[user_id]
        
        return deleted


async def export_database(user_id: str, name: str) -> Path:
    """Export a workspace to a JSON file."""
    import json
    
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")
    
    async with get_connection() as conn:
        workspace = await conn.fetchrow(
            "SELECT id, uuid, name FROM workspace WHERE owner_id = $1 AND name = $2",
            numeric_user_id, name
        )
        if not workspace:
            raise ValueError(f"Database '{name}' not found")
        
        workspace_id = workspace['id']
        
        nodes = await conn.fetch(
            """
            SELECT uuid, name, icon, color, parent_id, page_id, sequence,
                   collapsed, active, version, is_type, is_page, is_day,
                   is_month, is_year, is_asset, is_template, is_comment,
                   usable_in, types_path, open_date, create_date, write_date
            FROM node WHERE workspace_id = $1
            """,
            workspace_id
        )
        
        links = await conn.fetch(
            """
            SELECT nl.uuid, nl.source_node_id, nl.target_node_id, nl.link_type
            FROM node_link nl
            JOIN node n ON nl.source_node_id = n.id
            WHERE n.workspace_id = $1
            """,
            workspace_id
        )
        
        properties = await conn.fetch(
            """
            SELECT uuid, name, icon, type, is_multi, is_system
            FROM property WHERE workspace_id = $1 OR workspace_id IS NULL
            """,
            workspace_id
        )
        
        export_data = {
            "version": 1,
            "workspace": {"uuid": str(workspace['uuid']), "name": workspace['name']},
            "nodes": [dict(row) for row in nodes],
            "links": [dict(row) for row in links],
            "properties": [dict(row) for row in properties],
        }
        
        export_dir = DATA_DIR / "users" / user_id / "export"
        export_dir.mkdir(parents=True, exist_ok=True)
        export_path = export_dir / f"{name}_export.json"
        
        with open(export_path, 'w') as f:
            json.dump(export_data, f, default=str, indent=2)
        
        return export_path


async def import_database(user_id: str, file_path: Path, name: str) -> Dict[str, Any]:
    """Import a workspace from a JSON file."""
    logger.warning(f"Import not fully implemented - creating empty workspace '{name}'")
    return await create_database(user_id, name)


async def export_nodes(
    user_id: str,
    node_ids: List[str],
    format: Any,  # ExportFormat enum
    include_children: bool = True
) -> tuple:
    """Export nodes to various formats.
    
    Returns: (content: bytes, filename: str, mime_type: str)
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
                "SELECT id FROM workspace WHERE owner_id = $1 AND name = $2",
                numeric_user_id, workspace_name
            )
        else:
            workspace = await conn.fetchrow(
                "SELECT id FROM workspace WHERE owner_id = $1 ORDER BY create_date LIMIT 1",
                numeric_user_id
            )
        
        if not workspace:
            raise ValueError("No workspace found")
        
        workspace_id = workspace['id']
        
        # Fetch nodes
        nodes_data = []
        for node_uuid in node_ids:
            if include_children:
                # Get node and all descendants using recursive CTE
                rows = await conn.fetch(
                    """
                    WITH RECURSIVE tree AS (
                        SELECT id, uuid, name, parent_id, 0 as depth
                        FROM node 
                        WHERE workspace_id = $1 AND uuid::text = $2
                        UNION ALL
                        SELECT n.id, n.uuid, n.name, n.parent_id, t.depth + 1
                        FROM node n
                        JOIN tree t ON n.parent_id = t.id
                        WHERE n.workspace_id = $1
                    )
                    SELECT * FROM tree ORDER BY depth, id
                    """,
                    workspace_id, node_uuid
                )
            else:
                rows = await conn.fetch(
                    "SELECT id, uuid, name, parent_id FROM node WHERE workspace_id = $1 AND uuid::text = $2",
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
    """Convert nodes to Markdown format."""
    lines = []
    for node in nodes:
        name = node.get('name', '')
        lines.append(f"- {name}")
    return "\n".join(lines)


def _export_to_html(nodes: List[Dict]) -> str:
    """Convert nodes to HTML format."""
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


# ============== Stub Functions ==============
# These raise NotImplementedError to guide developers to the new pattern


async def create_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_node_by_uuid(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_node_by_name(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_daily_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_all_pages(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_root_pages(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_child_nodes(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_node_with_children(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def update_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def delete_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def move_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def ensure_year_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def ensure_month_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def create_or_get_daily_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def create_or_get_hierarchical_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def resolve_page_link(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def upsert_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def search_nodes(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_backlinks(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_all_tags(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_nodes_by_tag(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def execute_query(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_tasks(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def update_task_state(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_templates(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_properties(*args, **kwargs):
    raise NotImplementedError("Use properties router or PostgresPropertyRepository instead")


# ============== Legacy Context Management ==============
# Kept for backward compatibility but no longer used

_current_user_id: Optional[str] = None


def set_current_user(user_id: str):
    """Set the current user context (legacy - no longer used)."""
    global _current_user_id
    _current_user_id = user_id


def get_current_user() -> Optional[str]:
    """Get the current user ID (legacy - no longer used)."""
    return _current_user_id


# ============== Utility Functions ==============

def get_export_dir(user_id: str, db_name: str = "default") -> Path:
    """Get the export directory for a user.
    
    Note: In PostgreSQL version, consider using workspace-based paths instead.
    """
    from .db.connection import DATA_DIR
    export_dir = DATA_DIR / "users" / user_id / "export" / db_name
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir

