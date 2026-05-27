"""Auto-export router for Notees.

Handles automatic export of pages to Markdown files on save,
and batch re-export for force recreation.

Export format:
- Flat folder with UUID filenames: {uuid}.md
- YAML frontmatter with title, parents, tags, classes, properties
- Body uses existing stringify_ast PLAIN_MARKDOWN output
"""

from __future__ import annotations

import asyncio
import io
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..db.connection import clear_request_conn, get_connection, get_workspace_dir
from ..db.schema.init import get_or_create_user_workspace
from ..domain.stringify_ast import StringifyMode, StringifyOptions, parse_ast, stringify_ast
from ..logging_config import get_logger
from ..models import User
from ..node_export import export_nodes
from ..routers.auth import get_current_user
from ..workspace_manager import _active_workspaces, _get_numeric_user_id

logger = get_logger(__name__)

router = APIRouter(prefix="/api/auto-export", tags=["Auto Export"])

# ---------------------------------------------------------------------------
# In-memory export progress tracking (single-process only)
# ---------------------------------------------------------------------------


class BatchExportStatus(BaseModel):
    running: bool
    total: int
    completed: int
    current_page: str | None
    error: str | None


_batch_status: dict[str, BatchExportStatus] = {}
_status_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Filename helpers
# ---------------------------------------------------------------------------


def _extract_page_title(name: str | None) -> str:
    """Extract plain text title from a node's name (AST JSON or plain text)."""
    if not name:
        return "untitled"
    try:
        ast = parse_ast(name)
        opts = StringifyOptions(mode=StringifyMode.TEXT_ONLY)
        return stringify_ast(ast, opts) or "untitled"
    except Exception:
        return name.strip() or "untitled"


def _get_markdown_export_dir(workspace_uuid: str) -> Path:
    """Get the markdown export directory for a workspace."""
    export_dir = get_workspace_dir(workspace_uuid) / "markdown-export"
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir


# ---------------------------------------------------------------------------
# YAML frontmatter helpers
# ---------------------------------------------------------------------------


def _yaml_scalar(value: str) -> str:
    """Escape a string for YAML. Wrap in quotes if it contains special chars."""
    if not value:
        return '""'
    # If value contains newlines, use literal block scalar
    if "\n" in value:
        return "|\n" + "\n".join("  " + line for line in value.split("\n"))
    # If value contains yaml-special chars, quote it
    if any(c in value for c in [":", "#", "{", "}", "[", "]", ",", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`"]):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def _yaml_lines(value, indent: int = 0):
    """Yield YAML lines for a value at the given indentation level."""
    prefix = "  " * indent
    if value is None:
        yield prefix + "null"
    elif isinstance(value, bool):
        yield prefix + ("true" if value else "false")
    elif isinstance(value, (int, float)):
        yield prefix + str(value)
    elif isinstance(value, str):
        yield prefix + _yaml_scalar(value)
    elif isinstance(value, list):
        if not value:
            yield prefix + "[]"
        else:
            for item in value:
                if isinstance(item, dict) and item:
                    first = True
                    for line in _yaml_lines(item, indent + 1):
                        if first:
                            # Replace the indent with '- '
                            yield prefix + "- " + line[len(prefix + "  ") :]
                            first = False
                        else:
                            yield line
                elif isinstance(item, list) and item:
                    first = True
                    for line in _yaml_lines(item, indent + 1):
                        if first:
                            yield prefix + "- " + line[len(prefix + "  ") :]
                            first = False
                        else:
                            yield line
                else:
                    scalar = (
                        _yaml_scalar(item)
                        if isinstance(item, str)
                        else "true"
                        if item is True
                        else "false"
                        if item is False
                        else "null"
                        if item is None
                        else str(item)
                    )
                    yield prefix + "- " + scalar
    elif isinstance(value, dict):
        if not value:
            yield prefix + "{}"
        else:
            for k, v in value.items():
                if isinstance(v, dict) and v or isinstance(v, list) and v:
                    yield prefix + k + ":"
                    for line in _yaml_lines(v, indent + 1):
                        yield line
                else:
                    scalar = (
                        _yaml_scalar(v)
                        if isinstance(v, str)
                        else "true"
                        if v is True
                        else "false"
                        if v is False
                        else "null"
                        if v is None
                        else str(v)
                    )
                    yield prefix + k + ": " + scalar
    else:
        yield prefix + str(value)


def _build_yaml_frontmatter(data: dict) -> str:
    """Build a YAML frontmatter block from a dict."""
    lines = ["---"]
    for key, value in data.items():
        if isinstance(value, (dict, list)) and value:
            lines.append(key + ":")
            for line in _yaml_lines(value, 1):
                lines.append(line)
        else:
            scalar = (
                _yaml_scalar(value)
                if isinstance(value, str)
                else "true"
                if value is True
                else "false"
                if value is False
                else "null"
                if value is None
                else str(value)
            )
            lines.append(key + ": " + scalar)
    lines.append("---")
    return "\n".join(lines) + "\n\n"


# ---------------------------------------------------------------------------
# Node metadata fetching
# ---------------------------------------------------------------------------


async def _fetch_node_metadata(conn, workspace_id: int, node_uuid: str) -> dict:
    """Fetch node info, ancestors, tags, classes, and properties."""
    # 1. Basic node info
    node_row = await conn.fetchrow(
        """
        SELECT id, uuid::text as uuid, name, is_page, is_day, is_month, is_year,
               is_class, is_asset, is_template, is_comment, color, icon, class_ids,
               parent_id, create_date, write_date
        FROM node
        WHERE workspace_id = $1 AND uuid::text = $2
        """,
        workspace_id,
        node_uuid,
    )
    if not node_row:
        raise ValueError(f"Node not found: {node_uuid}")

    metadata = {
        "uuid": str(node_row["uuid"]),
        "id": node_row["id"],
        "title": _extract_page_title(node_row["name"]),
        "is_page": node_row["is_page"],
        "is_day": node_row["is_day"],
        "is_month": node_row["is_month"],
        "is_year": node_row["is_year"],
        "is_class": node_row["is_class"],
        "is_asset": node_row["is_asset"],
        "is_template": node_row["is_template"],
        "is_comment": node_row["is_comment"],
        "create_date": node_row["create_date"].isoformat() if node_row["create_date"] else None,
        "write_date": node_row["write_date"].isoformat() if node_row["write_date"] else None,
    }

    # 2. Ancestors (via closure table, ordered by depth ascending)
    ancestor_rows = await conn.fetch(
        """
        SELECT np.ancestor_id, np.depth, n.uuid::text as uuid, n.name
        FROM node_path np
        JOIN node n ON n.id = np.ancestor_id
        WHERE np.descendant_id = $1 AND np.depth > 0
        ORDER BY np.depth DESC
        """,
        node_row["id"],
    )
    parents = []
    for row in ancestor_rows:
        parents.append(
            {
                "uuid": str(row["uuid"]),
                "title": _extract_page_title(row["name"]),
                "depth": row["depth"],
            }
        )
    if parents:
        metadata["parents"] = parents

    # 3. Tags (node_link with is_tag = TRUE)
    tag_rows = await conn.fetch(
        """
        SELECT n.uuid::text as uuid, n.name
        FROM node_link nl
        JOIN node n ON n.id = nl.target_id
        WHERE nl.source_id = $1
          AND nl.is_tag = TRUE
          AND nl.property_id IS NULL
        ORDER BY nl.position
        """,
        node_row["id"],
    )
    if tag_rows:
        metadata["tags"] = [
            {
                "uuid": str(row["uuid"]),
                "name": _extract_page_title(row["name"]),
            }
            for row in tag_rows
        ]

    # 4. Classes (from class_ids array + extends chain)
    class_ids = list(node_row["class_ids"] or [])
    if class_ids:
        class_rows = await conn.fetch(
            """
            SELECT id, uuid::text as uuid, name
            FROM node
            WHERE id = ANY($1) AND active = TRUE
            ORDER BY array_position($1, id)
            """,
            class_ids,
        )
        metadata["classes"] = [
            {
                "uuid": str(row["uuid"]),
                "name": _extract_page_title(row["name"]),
            }
            for row in class_rows
        ]

    # 5. Properties
    prop_rows = await conn.fetch(
        """
        SELECT
            p.name AS property_name,
            p.type AS property_type,
            p.is_multi,
            pvs.value_text,
            pvs.value_boolean,
            pvs.value_float,
            pvs.value_integer,
            psl.name AS selection_value,
            pvr.target_id AS relation_target_id,
            rel.uuid::text AS relation_target_uuid,
            rel.name AS relation_target_name
        FROM node_property np
        JOIN property p ON p.id = np.property_id
        LEFT JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
        LEFT JOIN property_value_relation pvr ON pvr.node_property_id = np.id
        LEFT JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
        LEFT JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
        LEFT JOIN node rel ON rel.id = pvr.target_id
        WHERE np.node_id = $1
          AND p.active = TRUE
        ORDER BY p.name
        """,
        node_row["id"],
    )

    props_agg: dict[str, dict] = {}
    for row in prop_rows:
        prop_name = row["property_name"]
        prop_type = row["property_type"]
        if prop_name not in props_agg:
            props_agg[prop_name] = {
                "type": prop_type,
                "values": [],
            }

        value = None
        if prop_type == "integer" and row["value_integer"] is not None:
            value = row["value_integer"]
        elif prop_type == "float" and row["value_float"] is not None:
            value = row["value_float"]
        elif prop_type == "boolean" and row["value_boolean"] is not None:
            value = bool(row["value_boolean"])
        elif prop_type == "date" and row["value_text"] is not None:
            value = row["value_text"]
        elif prop_type == "selection" and row["selection_value"] is not None:
            value = row["selection_value"]
        elif prop_type in ("node", "text") and row["relation_target_id"] is not None:
            value = {
                "id": row["relation_target_id"],
                "uuid": str(row["relation_target_uuid"]) if row["relation_target_uuid"] else None,
                "name": _extract_page_title(row["relation_target_name"]),
            }
        elif prop_type == "text" and row["value_text"] is not None:
            value = row["value_text"]

        if value is not None and value not in props_agg[prop_name]["values"]:
            props_agg[prop_name]["values"].append(value)

    if props_agg:
        # For single-value props, flatten to scalar; for multi-value, keep list
        props_out = {}
        for prop_name, prop_data in props_agg.items():
            values = prop_data["values"]
            prop_type = prop_data["type"]
            if not values:
                continue
            if len(values) == 1 and prop_type != "text":
                props_out[prop_name] = values[0]
            else:
                props_out[prop_name] = values
        if props_out:
            metadata["properties"] = props_out

    # 6. Icon
    if node_row["icon"]:
        metadata["icon"] = node_row["icon"]

    return metadata


# ---------------------------------------------------------------------------
# Core export writer
# ---------------------------------------------------------------------------


async def _write_page_markdown(
    user_id: str,
    workspace_id: int,
    workspace_uuid: str,
    node_uuid: str,
) -> str:
    """Export a single page to markdown and write it to the export directory.

    Returns the filename written.
    """
    # 1. Export body content via existing engine
    content_bytes, _filename, _mime = await export_nodes(
        user_id,
        node_ids=[node_uuid],
        format="markdown",
        include_children=True,
        layout="outline",
        formatting=True,
        properties="none",
        link_style="raw",
    )
    body = content_bytes.decode("utf-8")

    # 2. Fetch metadata for YAML frontmatter
    async with get_connection() as conn:
        metadata = await _fetch_node_metadata(conn, workspace_id, node_uuid)

    # 3. Build YAML frontmatter and prepend to body
    frontmatter = _build_yaml_frontmatter(metadata)
    full_content = frontmatter + body

    # 4. Write to file (UUID filename, flat folder)
    filename = f"{node_uuid}.md"
    export_dir = _get_markdown_export_dir(workspace_uuid)
    file_path = export_dir / filename

    file_path.write_text(full_content, encoding="utf-8")
    return filename


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


class BatchExportRequest(BaseModel):
    pass


@router.post("/batch")
async def auto_export_batch(
    _request: BatchExportRequest,
    user: User = Depends(get_current_user),
):
    """Force re-export of all pages in the workspace to markdown.

    This is a dev/heavy operation that runs asynchronously and reports progress
    via the /status endpoint.
    """
    numeric_user_id = await _get_numeric_user_id(user.id)
    if not numeric_user_id:
        raise HTTPException(status_code=404, detail="User not found")

    active_uuid = _active_workspaces.get(user.id)

    async with get_connection() as conn:
        workspace_id = await get_or_create_user_workspace(conn, numeric_user_id, workspace_uuid=active_uuid)
        ws_row = await conn.fetchrow(
            "SELECT uuid::text as uuid FROM workspace WHERE id = $1",
            workspace_id,
        )
        workspace_uuid = ws_row["uuid"] if ws_row else active_uuid

    if not workspace_uuid:
        raise HTTPException(status_code=400, detail="No active workspace")

    status_key = f"{user.id}:{workspace_uuid}"

    async with _status_lock:
        if _batch_status.get(
            status_key, BatchExportStatus(running=False, total=0, completed=0, current_page=None, error=None)
        ).running:
            raise HTTPException(status_code=409, detail="Batch export already in progress")

        _batch_status[status_key] = BatchExportStatus(running=True, total=0, completed=0, current_page=None, error=None)

    # Start the batch export in the background
    asyncio.create_task(_run_batch_export(user.id, numeric_user_id, workspace_id, workspace_uuid, status_key))

    return {"status": "started"}


async def _run_batch_export(
    user_id: str,
    numeric_user_id: int,
    workspace_id: int,
    workspace_uuid: str,
    status_key: str,
):
    """Background task that exports all pages sequentially."""
    # Background tasks inherit the parent request's context variables,
    # including the request-scoped DB connection. Clear it so we don't
    # race with the middleware releasing the connection back to the pool.
    clear_request_conn()
    try:
        async with get_connection() as conn:
            rows = await conn.fetch(
                """
                SELECT uuid::text as uuid, name
                FROM node
                WHERE workspace_id = $1
                  AND is_page = TRUE
                  AND is_deleted = FALSE
                  AND active = TRUE
                ORDER BY id
                """,
                workspace_id,
            )

        page_uuids = [r["uuid"] for r in rows]
        total = len(page_uuids)

        async with _status_lock:
            _batch_status[status_key] = BatchExportStatus(
                running=True, total=total, completed=0, current_page=None, error=None
            )

        export_dir = _get_markdown_export_dir(workspace_uuid)
        # Clear existing exports before re-exporting
        for existing in export_dir.glob("*.md"):
            existing.unlink()

        for i, node_uuid in enumerate(page_uuids):
            title = _extract_page_title(rows[i]["name"])
            async with _status_lock:
                _batch_status[status_key] = BatchExportStatus(
                    running=True, total=total, completed=i, current_page=title, error=None
                )
            try:
                await _write_page_markdown(user_id, workspace_id, workspace_uuid, node_uuid)
            except Exception as e:
                logger.error(f"Batch export failed for page {node_uuid}: {e}")
                # Continue with other pages, record error at end

        async with _status_lock:
            _batch_status[status_key] = BatchExportStatus(
                running=False, total=total, completed=total, current_page=None, error=None
            )

    except Exception as e:
        logger.error(f"Batch export failed: {e}")
        async with _status_lock:
            _batch_status[status_key] = BatchExportStatus(
                running=False, total=0, completed=0, current_page=None, error=str(e)
            )


@router.post("/{node_uuid}")
async def auto_export_page(
    node_uuid: str,
    user: User = Depends(get_current_user),
):
    """Export a single page to the workspace markdown-export directory."""
    numeric_user_id = await _get_numeric_user_id(user.id)
    if not numeric_user_id:
        raise HTTPException(status_code=404, detail="User not found")

    active_uuid = _active_workspaces.get(user.id)

    async with get_connection() as conn:
        workspace_id = await get_or_create_user_workspace(conn, numeric_user_id, workspace_uuid=active_uuid)
        ws_row = await conn.fetchrow(
            "SELECT uuid::text as uuid FROM workspace WHERE id = $1",
            workspace_id,
        )
        workspace_uuid = ws_row["uuid"] if ws_row else active_uuid

    if not workspace_uuid:
        raise HTTPException(status_code=400, detail="No active workspace")

    try:
        filename = await _write_page_markdown(user.id, workspace_id, workspace_uuid, node_uuid)
    except ValueError as e:
        logger.warning(f"Auto-export failed for {node_uuid}: {e}")
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Auto-export error for {node_uuid}: {e}")
        raise HTTPException(status_code=500, detail=f"Export failed: {e}") from e

    return {"status": "ok", "filename": filename}


@router.get("/status")
async def auto_export_status(
    user: User = Depends(get_current_user),
):
    """Get the current batch export status."""
    active_uuid = _active_workspaces.get(user.id)
    if not active_uuid:
        return BatchExportStatus(running=False, total=0, completed=0, current_page=None, error=None)

    status_key = f"{user.id}:{active_uuid}"
    async with _status_lock:
        return _batch_status.get(
            status_key,
            BatchExportStatus(running=False, total=0, completed=0, current_page=None, error=None),
        )


@router.get("/download")
async def auto_export_download(
    user: User = Depends(get_current_user),
):
    """Download all exported markdown files as a ZIP archive."""
    numeric_user_id = await _get_numeric_user_id(user.id)
    if not numeric_user_id:
        raise HTTPException(status_code=404, detail="User not found")

    active_uuid = _active_workspaces.get(user.id)

    async with get_connection() as conn:
        workspace_id = await get_or_create_user_workspace(conn, numeric_user_id, workspace_uuid=active_uuid)
        workspace_row = await conn.fetchrow(
            """
            SELECT w.uuid::text as uuid, w.name
            FROM workspace w
            WHERE w.id = $1 AND w.active = TRUE
            """,
            workspace_id,
        )
        if not workspace_row:
            raise HTTPException(status_code=404, detail="Workspace not found")

        workspace_uuid = workspace_row["uuid"]
        workspace_name = workspace_row["name"] or "workspace"

    export_dir = _get_markdown_export_dir(workspace_uuid)
    md_files = sorted(export_dir.glob("*.md"))

    if not md_files:
        raise HTTPException(status_code=404, detail="No exported markdown files found")

    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    safe_name = workspace_name.replace(" ", "_").replace("/", "_")
    zip_filename = f"{safe_name}-md-{timestamp}.zip"

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for md_file in md_files:
            zf.write(md_file, md_file.name)
    buffer.seek(0)

    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{zip_filename}"',
        },
    )
