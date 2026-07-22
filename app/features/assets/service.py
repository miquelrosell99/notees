"""
Asset Service - WorkspaceStore-backed file uploads and downloads.

Files are stored content-addressed by SHA-256 hash. The operation log records
asset metadata via ``asset.upload`` / ``asset.delete`` operations, and the
derived ``node_asset`` table maps a node UUID to its file hash, MIME type, size,
and original filename.

This module no longer depends on the legacy ``NodeRepository`` or
``AssetRepository``; it uses :class:`app.core.workspace_store.WorkspaceStore`
for all operation-log writes and derived-state reads.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image

from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.domain.stringify_ast import ParseMode, parse_ast
from app.features.assets.utils import (
    ALLOWED_CONTENT_TYPES,
    get_asset_category,
    get_extension_from_content_type,
)
from app.logging_config import get_logger
from app.utils.paths import get_workspace_assets_dir

logger = get_logger(__name__)

# Maximum thumbnail dimensions
THUMBNAIL_MAX_WIDTH = 800
THUMBNAIL_MAX_HEIGHT = 600
THUMBNAIL_QUALITY = 85

# Image formats that support thumbnail generation
THUMBNAIL_FORMATS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}

ASSET_CLASS_UUID = SYSTEM_CLASS_UUIDS["asset"]


class AssetError(Exception):
    """Base exception for asset operations."""


class AssetMissingError(AssetError):
    """Asset node or file does not exist."""


class AssetInvariantViolationError(AssetError):
    """Asset storage invariant violated."""


class AssetPermissionError(AssetError):
    """Permission denied for asset operation."""

    def __init__(self, message: str):
        super().__init__(message)


def _validate_asset_uuid(asset_uuid: str) -> None:
    """Validate that ``asset_uuid`` is a well-formed UUID.

    Raises:
        AssetPermissionError: If the value is not a valid UUID.
    """
    from uuid import UUID

    try:
        UUID(asset_uuid)
    except ValueError as exc:
        raise AssetPermissionError(f"Invalid asset UUID: {asset_uuid}") from exc


class AssetFileService:
    """
    Infrastructure service for content-addressed asset filesystem operations.

    Files are stored at ``<workspace>/assets/<hash[:4]>/<hash>.<ext>``. A local
    SQLite database in the workspace assets directory tracks reference counts so
    duplicate uploads share the same bytes and unreferenced files are removed.
    """

    def __init__(self, workspace_uuid: str, assets_dir: Path | None = None):
        self.workspace_uuid = workspace_uuid
        self.assets_dir = assets_dir or get_workspace_assets_dir(workspace_uuid)
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self._ref_db_path = self.assets_dir / ".asset_refs.db"
        self._ensure_ref_schema()

    def _ensure_ref_schema(self) -> None:
        """Create the reference-count table if it does not exist."""
        with sqlite3.connect(self._ref_db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS asset_ref (
                    hash TEXT PRIMARY KEY,
                    extension TEXT NOT NULL,
                    refs_count INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.commit()

    @staticmethod
    def _hash_content(file_bytes: bytes) -> str:
        """Return the SHA-256 hex digest for ``file_bytes``."""
        return hashlib.sha256(file_bytes).hexdigest()

    def _storage_path(self, file_hash: str, extension: str) -> Path:
        """Return the content-addressed filesystem path for a hash + extension."""
        ext = extension.lower()
        if not ext.startswith("."):
            ext = f".{ext}"
        return self.assets_dir / file_hash[:4] / f"{file_hash}{ext}"

    def _get_ref(self, file_hash: str) -> tuple[str, int] | None:
        """Return (extension, refs_count) for ``file_hash``, or None."""
        with sqlite3.connect(self._ref_db_path) as conn:
            row = conn.execute(
                "SELECT extension, refs_count FROM asset_ref WHERE hash = ?",
                (file_hash,),
            ).fetchone()
            return (row[0], row[1]) if row else None

    def _increment_ref(self, file_hash: str, extension: str) -> int:
        """Increment the reference count for ``file_hash``.

        Inserts the row with ``extension`` if it does not exist.
        """
        with sqlite3.connect(self._ref_db_path) as conn:
            conn.execute(
                """
                INSERT INTO asset_ref (hash, extension, refs_count)
                VALUES (?, ?, 1)
                ON CONFLICT(hash) DO UPDATE SET
                    refs_count = refs_count + 1
                """,
                (file_hash, extension),
            )
            conn.commit()
            row = conn.execute("SELECT refs_count FROM asset_ref WHERE hash = ?", (file_hash,)).fetchone()
            return row[0] if row else 1

    def _decrement_ref(self, file_hash: str) -> int:
        """Decrement the reference count and return the new value."""
        with sqlite3.connect(self._ref_db_path) as conn:
            row = conn.execute("SELECT refs_count FROM asset_ref WHERE hash = ?", (file_hash,)).fetchone()
            if row is None:
                return 0
            new_count = max(0, row[0] - 1)
            conn.execute(
                "UPDATE asset_ref SET refs_count = ? WHERE hash = ?",
                (new_count, file_hash),
            )
            conn.commit()
            return new_count

    def _delete_ref_row(self, file_hash: str) -> None:
        """Remove the reference-count row for ``file_hash``."""
        with sqlite3.connect(self._ref_db_path) as conn:
            conn.execute("DELETE FROM asset_ref WHERE hash = ?", (file_hash,))
            conn.commit()

    async def create_asset(self, file_bytes: bytes, original_filename: str, content_type: str) -> tuple[str, str, Path]:
        """
        Create or reuse a content-addressed asset file.

        Returns: (file_hash, extension, source_path)

        The caller MUST emit the operation-log entry only after this succeeds.
        If this fails, no filesystem state is left behind.
        """
        file_hash = self._hash_content(file_bytes)
        size = len(file_bytes)

        existing = self._get_ref(file_hash)
        if existing is not None:
            extension, _ = existing
            refs = self._increment_ref(file_hash, extension)
            source_path = self._storage_path(file_hash, extension)
            logger.info(f"Reused asset file for hash {file_hash} (refs_count now {refs}, {size} bytes)")
            return file_hash, extension, source_path

        extension = get_extension_from_content_type(content_type)
        if not extension:
            raise AssetError(f"Cannot determine file extension for {original_filename}")

        source_path = self._storage_path(file_hash, extension)
        source_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=source_path.parent,
                delete=False,
                prefix=".tmp_",
                suffix=extension,
            ) as tmp_file:
                tmp_file.write(file_bytes)
                tmp_path = Path(tmp_file.name)

            tmp_path.rename(source_path)
            self._increment_ref(file_hash, extension)

            logger.info(f"Created asset file {file_hash} at {source_path} ({size} bytes)")
            return file_hash, extension, source_path

        except Exception as exc:
            if source_path.exists():
                with contextlib.suppress(OSError):
                    source_path.unlink()
            raise AssetError(f"Failed to create asset file: {exc}") from exc

    async def delete_asset(self, file_hash: str) -> bool:
        """
        Drop one reference to a content-addressed asset file.

        When the reference count reaches zero the file and the reference row are
        removed. Returns True when a file was deleted.
        """
        ref = self._get_ref(file_hash)
        if ref is None:
            logger.warning(f"asset hash {file_hash} not found for deletion")
            return False

        extension, _ = ref
        new_count = self._decrement_ref(file_hash)

        if new_count <= 0:
            source_path = self._storage_path(file_hash, extension)
            if source_path.exists():
                try:
                    source_path.unlink()
                    with contextlib.suppress(OSError):
                        source_path.parent.rmdir()
                except OSError as exc:
                    logger.warning(f"Failed to delete asset file {source_path}: {exc}")
            self._delete_ref_row(file_hash)

        logger.info(f"Decremented refs_count for asset hash {file_hash} (now {new_count})")
        return new_count <= 0

    def find_source_file(self, file_hash: str) -> Path | None:
        """Return the stored filesystem path for a file hash, if it exists."""
        ref = self._get_ref(file_hash)
        if ref is None:
            return None
        extension, _ = ref
        path = self._storage_path(file_hash, extension)
        return path if path.exists() else None

    def get_source_file(self, file_hash: str, extension: str) -> Path:
        """Get the source file path for a hash + extension."""
        return self._storage_path(file_hash, extension)

    def get_thumbnail_path(self, asset_uuid: str) -> Path:
        """Get the thumbnail path for an asset node."""
        from uuid import UUID

        folder = self.assets_dir / str(UUID(asset_uuid))
        folder.mkdir(parents=True, exist_ok=True)
        return folder / "thumbnail.webp"

    async def generate_thumbnail(self, asset_uuid: str, source_path: Path) -> None:
        """Generate a WebP thumbnail for an image asset."""
        thumbnail_path = self.get_thumbnail_path(asset_uuid)
        await asyncio.get_event_loop().run_in_executor(None, self._generate_thumbnail_sync, source_path, thumbnail_path)

    def _generate_thumbnail_sync(self, source_path: Path, thumbnail_path: Path) -> None:
        """Synchronous thumbnail generation (runs in thread pool)."""
        try:
            with Image.open(source_path) as img:
                if img.mode in ("RGBA", "LA", "P"):
                    background = Image.new("RGB", img.size, (255, 255, 255))
                    if img.mode == "P":
                        img = img.convert("RGBA")
                    background.paste(
                        img,
                        mask=img.split()[-1] if img.mode == "RGBA" else None,
                    )
                    img = background
                elif img.mode != "RGB":
                    img = img.convert("RGB")

                img.thumbnail(
                    (THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT),
                    Image.Resampling.LANCZOS,
                )
                img.save(thumbnail_path, "WEBP", quality=THUMBNAIL_QUALITY, method=6)
                logger.info(f"Generated thumbnail: {thumbnail_path.name} ({img.size[0]}x{img.size[1]})")
        except Exception as exc:
            logger.error(f"Failed to generate thumbnail for {source_path}: {exc}")
            raise

    def extract_extension(self, filepath: Path) -> str:
        """Extract and normalize file extension."""
        return filepath.suffix.lower()


class AssetService:
    """
    Domain orchestrator for asset operations on the operation-log core.

    Coordinates content-addressed filesystem writes (``AssetFileService``) with
    operation-log writes (``WorkspaceStore``). Routers delegate all asset
    mutation and lookup logic to this service.
    """

    def __init__(
        self,
        workspace_uuid: str,
        user_id: str,
        store: WorkspaceStore,
        assets_dir: Path | None = None,
    ):
        self.workspace_uuid = workspace_uuid
        self.user_id = user_id
        self._store = store
        self._file_service = AssetFileService(workspace_uuid, assets_dir)

    @property
    def file_service(self) -> AssetFileService:
        """Access the underlying filesystem adapter."""
        return self._file_service

    def _infer_content_type(self, file_path: Path) -> str:
        """Infer MIME type from the file extension."""
        ext = file_path.suffix.lower()
        for ct, e in ALLOWED_CONTENT_TYPES.items():
            if e == ext or (ext == ".jpeg" and e == ".jpg"):
                return ct
        return "application/octet-stream"

    def _name_to_content(self, name: str) -> list[dict[str, Any]]:
        """Convert a plain-text name into a node content AST."""
        return parse_ast(name, ParseMode.PLAIN)

    def _build_asset_dict(
        self,
        node_id: str,
        file_path: Path,
        original_name: str,
        content_type: str,
    ) -> dict[str, Any]:
        """Build the standard asset metadata dict returned by this service."""
        return {
            "uuid": node_id,
            "node_uuid": node_id,
            "filename": original_name,
            "content_type": content_type,
            "category": get_asset_category(content_type),
            "size_bytes": file_path.stat().st_size,
            "url": f"/api/assets/{node_id}",
        }

    async def _get_asset_row(self, asset_uuid: str) -> dict[str, Any] | None:
        """Return the joined node + node_asset row for an asset UUID."""
        rows = await self._store.query(
            """
            SELECT n.id AS node_id, n.kind, n.class_ids,
                   a.asset_hash, a.mime_type, a.size, a.original_name
            FROM node n
            JOIN node_asset a ON a.node_id = n.id
            WHERE n.id = ?
            """,
            (asset_uuid,),
        )
        return dict(rows[0]) if rows else None

    async def _node_exists(self, node_uuid: str) -> bool:
        """Return True if a node with ``node_uuid`` exists in derived state."""
        rows = await self._store.query("SELECT 1 FROM node WHERE id = ?", (node_uuid,))
        return bool(rows)

    async def upload_asset(
        self,
        file_bytes: bytes,
        filename: str,
        content_type: str,
        parent_uuid: str | None = None,
        existing_node_uuid: str | None = None,
        content: str | None = None,
    ) -> dict[str, Any]:
        """
        Persist an uploaded file as an asset node.

        Creates the content-addressed file first, then emits the operation-log
        operations that create/annotate the asset node. If
        ``existing_node_uuid`` is provided, that node is turned into an asset by
        assigning the asset class and emitting an ``asset.upload`` operation;
        otherwise a new block node is created under ``parent_uuid``.
        """
        if parent_uuid is not None and not await self._node_exists(parent_uuid):
            raise AssetMissingError("Parent node not found")

        file_hash, extension, source_path = await self._file_service.create_asset(
            file_bytes=file_bytes,
            original_filename=filename,
            content_type=content_type,
        )

        filename_without_ext = Path(filename).stem
        node_name = content if content is not None else filename_without_ext

        try:
            if existing_node_uuid is not None:
                if not await self._node_exists(existing_node_uuid):
                    raise AssetMissingError("Existing node not found")
                asset_uuid = existing_node_uuid
                await self._store.assign_class(asset_uuid, ASSET_CLASS_UUID)
            else:
                from app.core.uuid import uuidv7

                asset_uuid = uuidv7()
                await self._store.create_node(
                    asset_uuid,
                    "block",
                    parent_id=parent_uuid,
                    initial_content=self._name_to_content(node_name),
                    class_ids=[ASSET_CLASS_UUID],
                )

            await self._store.upload_asset(
                asset_id=asset_uuid,
                node_id=asset_uuid,
                file_hash=file_hash,
                mime_type=content_type,
                size=len(file_bytes),
                original_name=filename,
            )
            await self._store.sync()
        except Exception:
            await self._file_service.delete_asset(file_hash)
            raise

        if extension in THUMBNAIL_FORMATS:
            try:
                await self._file_service.generate_thumbnail(asset_uuid, source_path)
            except Exception as exc:
                logger.warning(f"Failed to generate thumbnail for {asset_uuid}: {exc}")

        return self._build_asset_dict(asset_uuid, source_path, filename, content_type)

    async def get_asset_info(self, asset_uuid: str) -> dict[str, Any]:
        """Return metadata for an asset node and its on-disk file."""
        _validate_asset_uuid(asset_uuid)
        await self._store.sync()
        row = await self._get_asset_row(asset_uuid)
        if row is None:
            raise AssetMissingError("Asset not found")

        file_path = self._file_service.find_source_file(row["asset_hash"])
        if file_path is None:
            raise AssetMissingError("Asset file not found")

        return self._build_asset_dict(
            asset_uuid,
            file_path,
            row["original_name"],
            row["mime_type"],
        )

    async def delete_asset(self, asset_uuid: str) -> dict[str, Any]:
        """Delete an asset node and drop its reference to the content file."""
        _validate_asset_uuid(asset_uuid)
        await self._store.sync()
        row = await self._get_asset_row(asset_uuid)
        if row is None:
            raise AssetMissingError("Asset not found")

        file_hash = row["asset_hash"]

        await self._store.delete_node(asset_uuid)
        await self._store.delete_asset(asset_uuid, asset_uuid)
        await self._store.sync()

        await self._file_service.delete_asset(file_hash)

        return {"status": "deleted", "uuid": asset_uuid}

    async def list_assets(self, page: int, page_size: int) -> dict[str, Any]:
        """Return a paginated list of assets in the workspace."""
        await self._store.sync()
        offset = (page - 1) * page_size

        # Count nodes that have the asset class assigned.
        count_rows = await self._store.query(
            """
            SELECT COUNT(*) AS total
            FROM node
            WHERE kind = 'block'
              AND class_ids LIKE ?
            """,
            (f'%"{ASSET_CLASS_UUID}"%',),
        )
        total = count_rows[0]["total"]

        rows = await self._store.query(
            """
            SELECT n.id AS node_id, a.asset_hash, a.mime_type, a.size, a.original_name
            FROM node n
            JOIN node_asset a ON a.node_id = n.id
            WHERE n.kind = 'block'
              AND n.class_ids LIKE ?
            ORDER BY n.created_at DESC
            LIMIT ? OFFSET ?
            """,
            (f'%"{ASSET_CLASS_UUID}"%', page_size, offset),
        )

        assets = []
        for row in rows:
            file_path = self._file_service.find_source_file(row["asset_hash"])
            if file_path is not None:
                assets.append(
                    self._build_asset_dict(
                        row["node_id"],
                        file_path,
                        row["original_name"],
                        row["mime_type"],
                    )
                )

        return {"assets": assets, "total": total}

    async def asset_exists(self, asset_uuid: str) -> bool:
        """Return True if an asset node with the given UUID exists."""
        _validate_asset_uuid(asset_uuid)
        await self._store.sync()
        rows = await self._store.query(
            """
            SELECT 1 FROM node_asset WHERE node_id = ?
            """,
            (asset_uuid,),
        )
        return bool(rows)

    async def get_asset_file_path(self, asset_uuid: str) -> Path | None:
        """Return the source file path for an asset, or None if missing."""
        _validate_asset_uuid(asset_uuid)
        await self._store.sync()
        rows = await self._store.query(
            "SELECT asset_hash FROM node_asset WHERE node_id = ?",
            (asset_uuid,),
        )
        if not rows:
            return None
        return self._file_service.find_source_file(rows[0]["asset_hash"])
