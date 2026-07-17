"""Migrate assets from the legacy PostgreSQL schema to ideal operations.

Each row in the legacy ``asset`` table becomes a File-class node with a
``file`` property holding content metadata. The actual blob is copied (never
moved) from the legacy assets directory to a content-addressed ``files/``
directory so the original data remains intact.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any
from uuid import UUID

import asyncpg

from app.core.migration.nodes import MigrationContext
from app.core.migration.writer import OperationWriter
from app.core.operation import create_operation
from app.core.uuid import uuidv7
from app.features.assets.utils import get_extension_from_content_type


async def fetch_assets(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> list[asyncpg.Record]:
    """Return asset rows for a workspace ordered by id."""
    query = """
        SELECT id, uuid, workspace_id, hash, size, mime_type, original_name
        FROM asset
        WHERE workspace_id = $1
        ORDER BY id
    """
    return await conn.fetch(query, workspace_int_id)


async def fetch_asset_referencing_nodes(
    conn: asyncpg.Connection,
    workspace_int_id: int,
    asset_ids: list[int],
) -> dict[int, list[asyncpg.Record]]:
    """Return live nodes that reference each asset id via ``asset_id``.

    The returned mapping is ``asset_id -> list of node rows`` where each row
    contains ``id``, ``uuid``, ``is_page`` and ``is_asset``.
    """
    if not asset_ids:
        return {}

    rows = await conn.fetch(
        """
        SELECT id, uuid, asset_id, is_page, is_asset
        FROM node
        WHERE workspace_id = $1
          AND asset_id = ANY($2)
          AND is_deleted = FALSE
        ORDER BY asset_id, id
        """,
        workspace_int_id,
        asset_ids,
    )
    result: dict[int, list[asyncpg.Record]] = {}
    for row in rows:
        result.setdefault(row["asset_id"], []).append(row)
    return result


def _is_valid_uuid(value: Any) -> bool:
    """Return True if ``value`` is a valid UUID (object or string)."""
    if isinstance(value, UUID):
        return True
    if not isinstance(value, str):
        return False
    try:
        UUID(value)
    except ValueError:
        return False
    return True


def _file_class_id(ctx: MigrationContext) -> str:
    """Return the system class id used for migrated file nodes.

    Legacy file uploads are represented as ``asset`` class nodes in the ideal
    architecture, reusing the existing system ``asset`` class id so no new
    class node has to be invented during migration. If the context was built
    without an ``is_asset`` entry (e.g. unit tests), a stable id is generated
    once and cached on the context.
    """
    if "is_asset" not in ctx.system_class_ids:
        ctx.system_class_ids["is_asset"] = uuidv7()
    return ctx.system_class_ids["is_asset"]


def _file_property_schema_id(ctx: MigrationContext) -> str:
    """Return a stable schema id for the ``file`` property.

    The id is deterministic per workspace so repeated migrations converge on
    the same property schema without needing an explicit
    ``propertySchema.create`` operation first.
    """
    return f"file-schema-{ctx.workspace_uuid}"


def _asset_node_id(
    asset_row: asyncpg.Record,
    referencing: list[asyncpg.Record] | None,
    ctx: MigrationContext,
) -> str:
    """Choose the ideal node id for an asset.

    Priority:
    1. The UUID of a live asset node that references this asset.
    2. The asset row's own UUID if it is a valid UUID.
    3. A fresh UUIDv7.
    """
    if referencing:
        primary = referencing[0]
        node_id = ctx.id_map.get(primary["id"])
        if node_id is None:
            existing = primary.get("uuid")
            node_id = str(existing) if _is_valid_uuid(existing) else uuidv7()
            ctx.id_map[primary["id"]] = node_id
        return node_id

    existing = asset_row.get("uuid")
    if _is_valid_uuid(existing):
        return str(existing)
    return uuidv7()


def _asset_kind(referencing: list[asyncpg.Record] | None) -> str:
    """Return ``page`` if any referencing node is a page, otherwise ``block``."""
    if referencing and any(row["is_page"] for row in referencing):
        return "page"
    return "block"


def _extension_variants(ext: str) -> list[str]:
    """Return possible spellings for a file extension.

    Handles the common jpeg/jpg mismatch between stored mime_type and on-disk
    legacy filenames.
    """
    ext = ext.lower()
    if ext == ".jpg":
        return [".jpg", ".jpeg"]
    if ext == ".jpeg":
        return [".jpeg", ".jpg"]
    return [ext]


def _legacy_asset_paths(
    workspace_uuid: str,
    asset_uuid: str,
    file_hash: str,
    mime_type: str | None,
    data_dir: Path,
) -> list[Path]:
    """Return candidate source paths for an asset blob, most likely first."""
    exts = _extension_variants(get_extension_from_content_type(mime_type or ""))
    assets_base = data_dir / "workspaces" / workspace_uuid / "assets"
    candidates: list[Path] = []

    # Current content-addressed layout.
    if file_hash:
        for ext in exts:
            candidates.append(assets_base / file_hash[:4] / f"{file_hash}{ext}")

    # Legacy per-asset folder layouts.
    if _is_valid_uuid(asset_uuid):
        asset_folder = assets_base / asset_uuid
        for ext in exts:
            candidates.extend(
                [
                    asset_folder / f"{asset_uuid}{ext}",
                    asset_folder / f"main{ext}",
                ]
            )

    return candidates


def _new_file_path(
    workspace_uuid: str,
    file_hash: str,
    mime_type: str | None,
    data_dir: Path,
) -> Path:
    """Return the content-addressed destination path for an asset blob."""
    ext = get_extension_from_content_type(mime_type or "")
    return data_dir / "workspaces" / workspace_uuid / "files" / f"{file_hash}{ext}"


def _find_source_file(candidates: list[Path]) -> Path | None:
    """Return the first existing candidate path, or None."""
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def _copy_asset_file(
    source: Path,
    destination: Path,
) -> None:
    """Copy an asset blob to its new content-addressed home.

    The copy preserves the original (``shutil.copy2`` copies metadata but leaves
    the source intact). Parent directories are created as needed.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


async def migrate_assets_for_workspace(
    conn: asyncpg.Connection,
    workspace_int_id: int,
    ctx: MigrationContext,
    writer: OperationWriter,
    data_dir: Path | None = None,
    copy_files: bool = True,
) -> int:
    """Migrate one workspace's assets into the target operation store.

    Args:
        conn: Asyncpg connection to the source PostgreSQL database.
        workspace_int_id: Legacy integer id of the workspace to migrate.
        ctx: Shared migration context (id_map, system class ids, HLC clock).
        writer: Operation sink (SQLite file or in-memory collector).
        data_dir: Base data directory for resolving legacy asset paths and the
            destination ``files/`` tree. Defaults to ``Path("data")``.
        copy_files: When False, operations are generated but blobs are not
            copied. Useful for dry runs and tests that do not need files.

    Returns:
        Number of operations written.
    """
    if data_dir is None:
        data_dir = Path("data")

    assets = await fetch_assets(conn, workspace_int_id)
    if not assets:
        return 0

    asset_ids = [row["id"] for row in assets]
    referencing_map = await fetch_asset_referencing_nodes(
        conn, workspace_int_id, asset_ids
    )

    file_class_id = _file_class_id(ctx)
    file_schema_id = _file_property_schema_id(ctx)

    operations: list[dict[str, Any]] = []
    for row in assets:
        asset_id = row["id"]
        referencing = referencing_map.get(asset_id)
        node_id = _asset_node_id(row, referencing, ctx)
        kind = _asset_kind(referencing)

        operations.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [node_id],
                    "op_type": "node.create",
                },
                payload={
                    "nodeId": node_id,
                    "kind": kind,
                    "index": "0",
                },
            )
        )

        operations.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [node_id, file_class_id],
                    "op_type": "class.assign",
                },
                payload={"nodeId": node_id, "classId": file_class_id},
            )
        )

        operations.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [node_id],
                    "op_type": "property.set",
                },
                payload={
                    "propertyValueId": uuidv7(),
                    "nodeId": node_id,
                    "schemaId": file_schema_id,
                    "index": 0,
                    "value": {"value": {
                        "hash": row["hash"],
                        "filename": row["original_name"] or "",
                        "mime_type": row["mime_type"] or "",
                        "size": row["size"],
                    }},
                },
            )
        )

        if copy_files:
            candidates = _legacy_asset_paths(
                ctx.workspace_uuid,
                str(row["uuid"]) if row.get("uuid") else "",
                row["hash"],
                row["mime_type"],
                data_dir,
            )
            source_path = _find_source_file(candidates)
            if source_path is not None:
                destination = _new_file_path(
                    ctx.workspace_uuid,
                    row["hash"],
                    row["mime_type"],
                    data_dir,
                )
                _copy_asset_file(source_path, destination)

    for operation in operations:
        writer.write_operation(operation)

    return len(operations)
