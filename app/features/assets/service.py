"""
Asset Service - All filesystem mutations and domain orchestration for asset management.

CRITICAL INVARIANTS (enforced by this service):
1. One asset node points to one asset_file record via asset_file_id
2. One asset_file record stores exactly one source file at a content-addressed path
3. asset_file.hash is the SHA-256 of the file bytes and is unique per workspace
4. asset_file.ref_count tracks how many asset nodes reference the file
5. File extension is authoritative for MIME inference
6. Block name (node.name) is semantic only and NEVER affects disk state
7. Asset blocks are atomic (cursor cannot enter)

The ``AssetFileService`` class is the ONLY layer that performs asset filesystem
operations.  ``AssetService`` is the domain orchestrator that coordinates
validation, filesystem writes, and node persistence through repository interfaces.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

from PIL import Image

from app.domain.entities import generate_uuid
from app.domain.errors import PermissionDeniedError
from app.domain.stringify_ast import ParseMode, parse_ast, serialize_ast
from app.features.assets.utils import ALLOWED_CONTENT_TYPES, get_asset_category, get_extension_from_content_type
from app.logging_config import get_logger
from app.utils.paths import get_workspace_assets_dir

if TYPE_CHECKING:
    from app.domain.entities import Node
    from app.features.assets.port import AssetRepository
from app.features.nodes.port import NodeRepository

logger = get_logger(__name__)

# Maximum thumbnail dimensions
THUMBNAIL_MAX_WIDTH = 800
THUMBNAIL_MAX_HEIGHT = 600
THUMBNAIL_QUALITY = 85

# Image formats that support thumbnail generation
THUMBNAIL_FORMATS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


class AssetError(Exception):
    """Base exception for asset operations."""

    pass


class AssetMissingError(AssetError):
    """Asset folder or file does not exist."""

    pass


class AssetInvariantViolationError(AssetError):
    """Asset folder violates core invariants."""

    pass


class AssetPermissionError(PermissionDeniedError):
    """Permission denied for asset operation."""

    def __init__(self, message: str):
        super().__init__(message=message)


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
    Infrastructure service for asset filesystem operations.

    Files are stored by content hash so duplicate uploads share the same bytes.
    Asset nodes keep a foreign key to the shared ``asset_file`` row.
    """

    def __init__(self, workspace_uuid: str, asset_repo: AssetRepository):
        self.workspace_uuid = workspace_uuid
        self.assets_dir = get_workspace_assets_dir(workspace_uuid)
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self._asset_repo = asset_repo

    @property
    def _assets_dir_resolved(self) -> Path:
        """Resolved assets directory, recomputed to support test overrides."""
        return self.assets_dir.resolve()

    @staticmethod
    def _hash_content(file_bytes: bytes) -> str:
        """Return the SHA-256 hex digest for ``file_bytes``."""
        return hashlib.sha256(file_bytes).hexdigest()

    def _storage_path(self, hash: str, extension: str) -> Path:
        """Return the content-addressed filesystem path for a hash + extension."""
        ext = extension.lower()
        if not ext.startswith("."):
            ext = f".{ext}"
        return self.assets_dir / "files" / hash[:2] / hash[2:4] / f"{hash}{ext}"

    def _extract_extension(self, filepath: Path) -> str:
        """Extract and normalize file extension."""
        return filepath.suffix.lower()

    async def create_asset(
        self, file_bytes: bytes, original_filename: str, content_type: str
    ) -> tuple[int, str, Path]:
        """
        Create or reuse a content-addressed asset file.

        Returns: (asset_file_id, extension, source_path)

        The caller MUST create the asset node ONLY after this succeeds.
        If this fails, no filesystem state is left behind.
        """
        file_hash = self._hash_content(file_bytes)
        size_bytes = len(file_bytes)

        existing = await self._asset_repo.find_asset_file_by_hash(file_hash)
        if existing is not None:
            await self._asset_repo.increment_asset_file_ref_count(existing["id"])
            source_path = Path(existing["storage_path"])
            logger.info(
                f"Reused asset_file {existing['id']} for hash {file_hash} "
                f"(ref_count now {existing['ref_count'] + 1})"
            )
            return existing["id"], existing["extension"], source_path

        original_path = Path(original_filename)
        extension = self._extract_extension(original_path)
        if not extension:
            extension = get_extension_from_content_type(content_type)
            if not extension:
                raise AssetError(f"Cannot determine file extension for {original_filename}")

        source_path = self._storage_path(file_hash, extension)
        source_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=source_path.parent, delete=False, prefix=".tmp_", suffix=extension
            ) as tmp_file:
                tmp_file.write(file_bytes)
                tmp_path = Path(tmp_file.name)

            tmp_path.rename(source_path)

            asset_file_id = await self._asset_repo.create_asset_file(
                hash=file_hash,
                size_bytes=size_bytes,
                extension=extension,
                storage_path=str(source_path),
                user_id=0,
            )

            logger.info(f"Created asset_file {asset_file_id} at {source_path} ({size_bytes} bytes)")
            return asset_file_id, extension, source_path

        except Exception as exc:
            if source_path.exists():
                with contextlib.suppress(OSError):
                    source_path.unlink()
            raise AssetError(f"Failed to create asset file: {exc}") from exc

    async def delete_asset(self, asset_file_id: int) -> bool:
        """
        Drop one reference to a content-addressed asset file.

        When the reference count reaches zero the file and the ``asset_file`` row
        are removed. Returns True when a file was deleted.
        """
        file_row = await self._asset_repo.get_asset_file_by_id(asset_file_id)
        if file_row is None:
            logger.warning(f"asset_file {asset_file_id} not found for deletion")
            return False

        new_count = await self._asset_repo.decrement_asset_file_ref_count(asset_file_id)

        if new_count <= 0:
            path = Path(file_row["storage_path"])
            try:
                if path.exists():
                    path.unlink()
                    # Clean up empty parent directories
                for parent in [path.parent, path.parent.parent]:
                    with contextlib.suppress(OSError):
                        parent.rmdir()
            except OSError as exc:
                logger.warning(f"Failed to delete asset file {path}: {exc}")

        logger.info(
            f"Decremented ref_count for asset_file {asset_file_id} (now {new_count})"
        )
        return new_count <= 0

    def get_source_file(self, asset_file_id: int, extension: str) -> Path:
        """Get the source file path for an asset_file record (uses stored path)."""
        # Kept for interface compatibility; callers should prefer find_source_file.
        return self._storage_path(str(asset_file_id), extension)

    async def find_source_file(self, asset_file_id: int | None) -> Path | None:
        """Return the stored filesystem path for an asset_file id."""
        if asset_file_id is None:
            return None
        file_row = await self._asset_repo.get_asset_file_by_id(asset_file_id)
        if file_row is None:
            return None
        path = Path(file_row["storage_path"])
        if not path.exists():
            return None
        return path

    def get_thumbnail_path(self, asset_uuid: str) -> Path:
        """Get the thumbnail path for an asset node."""
        from uuid import UUID

        folder = self.assets_dir / str(UUID(asset_uuid))
        folder.mkdir(parents=True, exist_ok=True)
        return folder / "thumbnail.webp"

    async def generate_thumbnail(self, asset_uuid: str, source_path: Path) -> None:
        """Generate a WebP thumbnail for an image asset."""
        thumbnail_path = self.get_thumbnail_path(asset_uuid)
        await asyncio.get_event_loop().run_in_executor(
            None, self._generate_thumbnail_sync, source_path, thumbnail_path
        )

    def _generate_thumbnail_sync(self, source_path: Path, thumbnail_path: Path) -> None:
        """Synchronous thumbnail generation (runs in thread pool)."""
        try:
            with Image.open(source_path) as img:
                if img.mode in ("RGBA", "LA", "P"):
                    background = Image.new("RGB", img.size, (255, 255, 255))
                    if img.mode == "P":
                        img = img.convert("RGBA")
                    background.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
                    img = background
                elif img.mode != "RGB":
                    img = img.convert("RGB")

                img.thumbnail((THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT), Image.Resampling.LANCZOS)
                img.save(thumbnail_path, "WEBP", quality=THUMBNAIL_QUALITY, method=6)
                logger.info(f"Generated thumbnail: {thumbnail_path.name} ({img.size[0]}x{img.size[1]})")
        except Exception as exc:
            logger.error(f"Failed to generate thumbnail for {source_path}: {exc}")
            raise

    def extract_extension(self, filepath: Path) -> str:
        """Extract and normalize file extension."""
        return self._extract_extension(filepath)

class AssetService:
    """
    Domain orchestrator for asset operations.

    Coordinates filesystem writes (``AssetFileService``) with node persistence
    (``NodeRepository`` / ``AssetRepository``).  Routers should delegate all
    asset mutation and lookup logic to this service.
    """

    def __init__(
        self,
        workspace_uuid: str,
        user_id: int,
        node_repo: NodeRepository,
        asset_repo: AssetRepository,
    ):
        self.workspace_uuid = workspace_uuid
        self.user_id = user_id
        self._node_repo = node_repo
        self._asset_repo = asset_repo
        self._file_service = AssetFileService(workspace_uuid, asset_repo)

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

    def _build_asset_dict(
        self,
        node: Node,
        file_path: Path,
        original_filename: str | None = None,
    ) -> dict:
        """Build the standard asset metadata dict returned by this service."""
        content_type = self._infer_content_type(file_path)
        return {
            "uuid": node.uuid,
            "node_id": node.id,
            "filename": original_filename if original_filename is not None else node.name,
            "content_type": content_type,
            "category": get_asset_category(content_type),
            "size_bytes": file_path.stat().st_size,
            "url": f"/api/assets/{node.uuid}",
        }

    async def upload_asset(
        self,
        file_bytes: bytes,
        filename: str,
        content_type: str,
        parent_id: int | None = None,
        existing_node_id: int | None = None,
        content: str | None = None,
    ) -> dict:
        """
        Persist an uploaded file as an asset node.

        Creates the content-addressed file first, then creates or converts the
        node.  If ``existing_node_id`` is provided, that node is turned into an
        asset; otherwise a new node is created under ``parent_id``.
        """
        asset_file_id, extension, source_path = await self._file_service.create_asset(
            file_bytes=file_bytes,
            original_filename=filename,
            content_type=content_type,
        )

        page_class_id, asset_class_id = await self._asset_repo.get_page_and_asset_class_ids(self.user_id)
        filename_without_ext = Path(filename).stem
        asset_uuid = generate_uuid()

        from app.domain.entities import NodeCreateData

        try:
            if existing_node_id is not None:
                node_name = content if content is not None else filename_without_ext
                await self._asset_repo.convert_node_to_asset(
                    node_id=existing_node_id,
                    asset_uuid=asset_uuid,
                    name=serialize_ast(parse_ast(node_name, ParseMode.PLAIN)),
                    asset_class_id=asset_class_id,
                    user_id=self.user_id,
                    asset_file_id=asset_file_id,
                )
                node = await self._node_repo.get_by_id(existing_node_id)
                if node is None:
                    raise AssetError("Failed to update node to asset")
            else:
                data = NodeCreateData(
                    uuid=asset_uuid,
                    name=serialize_ast(parse_ast(filename_without_ext, ParseMode.PLAIN)),
                    parent_id=parent_id,
                    classes=[asset_class_id] if asset_class_id else [],
                    asset_file_id=asset_file_id,
                )
                node = await self._node_repo.create(data, user_id=self.user_id)
        except Exception:
            await self._file_service.delete_asset(asset_file_id)
            raise

        if node.id is None:
            await self._file_service.delete_asset(asset_file_id)
            raise AssetError("Failed to create asset node")

        if extension in THUMBNAIL_FORMATS:
            try:
                await self._file_service.generate_thumbnail(asset_uuid, source_path)
            except Exception as exc:
                logger.warning(f"Failed to generate thumbnail for {asset_uuid}: {exc}")

        return self._build_asset_dict(node, source_path, original_filename=filename)

    async def get_asset_info(self, asset_uuid: str) -> dict:
        """Return metadata for an asset node and its on-disk file."""
        _validate_asset_uuid(asset_uuid)
        node = await self._node_repo.get_by_uuid(asset_uuid)
        if node is None:
            raise AssetMissingError("Asset node not found")

        file_path = await self._file_service.find_source_file(node.asset_file_id)
        if file_path is None:
            raise AssetMissingError("Asset file not found")

        return self._build_asset_dict(node, file_path)

    async def delete_asset(self, asset_uuid: str) -> dict:
        """Delete an asset node and drop its reference to the content file."""
        _validate_asset_uuid(asset_uuid)
        node = await self._node_repo.get_by_uuid(asset_uuid)
        if node is None:
            raise AssetMissingError("Asset node not found")

        if node.id is not None:
            await self._node_repo.delete(node.id)

        if node.asset_file_id is not None:
            await self._file_service.delete_asset(node.asset_file_id)

        return {"status": "deleted", "uuid": asset_uuid}

    async def list_assets(self, page: int, page_size: int) -> dict:
        """Return a paginated list of assets in the workspace."""
        _, asset_class_id = await self._asset_repo.get_page_and_asset_class_ids(self.user_id)
        if asset_class_id is None:
            return {"assets": [], "total": 0}

        offset = (page - 1) * page_size
        nodes = await self._node_repo.get_typed_with(asset_class_id, limit=page_size, offset=offset)
        total = await self._node_repo.count_nodes_with_classes([asset_class_id])

        assets = []
        for node in nodes:
            file_path = await self._file_service.find_source_file(node.asset_file_id)
            if file_path is not None and node.id is not None:
                assets.append(self._build_asset_dict(node, file_path))

        return {"assets": assets, "total": total}

    async def asset_exists(self, asset_uuid: str) -> bool:
        """Return True if an asset node with the given UUID exists."""
        _validate_asset_uuid(asset_uuid)
        return await self._asset_repo.asset_exists_by_uuid(asset_uuid)

    async def get_asset_file_path(self, asset_uuid: str) -> Path | None:
        """Return the source file path for an asset, or None if missing."""
        _validate_asset_uuid(asset_uuid)
        node = await self._node_repo.get_by_uuid(asset_uuid)
        if node is None:
            return None
        return await self._file_service.find_source_file(node.asset_file_id)
