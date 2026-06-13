"""
Asset Service - All filesystem mutations and domain orchestration for asset management.

CRITICAL INVARIANTS (enforced by this service):
1. One asset node ↔ one asset folder
2. One asset folder ↔ exactly one source file named main.<ext>
3. UUID is immutable
4. File extension is authoritative for MIME inference
5. Block name (node.name) is semantic only and NEVER affects disk state
6. Asset blocks are atomic (cursor cannot enter)

The ``AssetFileService`` class is the ONLY layer that performs asset filesystem
operations.  ``AssetService`` is the domain orchestrator that coordinates
validation, filesystem writes, and node persistence through repository interfaces.
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
import uuid as uuid_module
from pathlib import Path
from typing import TYPE_CHECKING

from PIL import Image

from app.db.connection import get_workspace_assets_dir
from app.domain.errors import PermissionDeniedError
from app.domain.stringify_ast import ParseMode, parse_ast, serialize_ast
from app.logging_config import get_logger
from app.utils.assets import ALLOWED_CONTENT_TYPES, get_asset_category, get_extension_from_content_type

if TYPE_CHECKING:
    from app.domain.entities import Node
    from app.domain.repositories.interfaces import AssetRepository, NodeRepository

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


class AssetPermissionError(AssetError):
    """Permission denied for asset operation."""

    pass


class AssetFileService:
    """
    Infrastructure service for asset filesystem operations.

    Enforces atomic operations and maintains asset invariants.  This class must
    never perform database access directly; callers use repositories for that.
    """

    def __init__(self, workspace_uuid: str):
        self.workspace_uuid = workspace_uuid
        self.assets_dir = get_workspace_assets_dir(workspace_uuid)
        self.assets_dir.mkdir(parents=True, exist_ok=True)

    def get_asset_folder(self, asset_uuid: str) -> Path:
        """Get the folder path for an asset."""
        return self.assets_dir / asset_uuid

    def get_source_file(self, asset_uuid: str, extension: str) -> Path:
        """Get the source file path for an asset."""
        # Normalize extension to lowercase
        ext = extension.lower()
        if not ext.startswith("."):
            ext = f".{ext}"
        return self.get_asset_folder(asset_uuid) / f"main{ext}"

    def get_thumbnail_path(self, asset_uuid: str) -> Path:
        """Get the thumbnail path for an asset."""
        return self.get_asset_folder(asset_uuid) / "thumbnail.webp"

    def find_source_file(self, asset_uuid: str) -> Path | None:
        """
        Find the source file in an asset folder.

        Returns None if folder doesn't exist.
        Raises AssetInvariantViolationError if multiple or zero source files found.
        """
        folder = self.get_asset_folder(asset_uuid)

        if not folder.exists():
            return None

        if not folder.is_dir():
            raise AssetInvariantViolationError(f"Asset path exists but is not a folder: {asset_uuid}")

        # Find all files that match main.<ext> pattern
        source_files = [f for f in folder.iterdir() if f.is_file() and f.stem == "main" and f.name != "thumbnail.webp"]

        if len(source_files) == 0:
            raise AssetInvariantViolationError(f"Asset folder has no source file: {asset_uuid}")

        if len(source_files) > 1:
            raise AssetInvariantViolationError(
                f"Asset folder has multiple source files: {asset_uuid} - {[f.name for f in source_files]}"
            )

        return source_files[0]

    def extract_extension(self, filepath: Path) -> str:
        """Extract and normalize file extension."""
        return filepath.suffix.lower()

    async def create_asset(self, file_bytes: bytes, original_filename: str, content_type: str) -> tuple[str, str]:
        """
        Create a new asset with atomic filesystem operations.

        ORDER OF OPERATIONS (CRITICAL):
        1. Generate UUID
        2. Create folder
        3. Write to temp file
        4. Atomic rename to final location
        5. Generate thumbnail (if applicable)

        Returns: (uuid, extension)

        The caller MUST create the node ONLY after this succeeds.
        If this fails, no filesystem state is left behind.
        """
        # Generate UUID
        asset_uuid = str(uuid_module.uuid4())

        # Extract extension from original filename
        original_path = Path(original_filename)
        extension = self.extract_extension(original_path)

        if not extension:
            # Fallback: try to infer from content_type
            extension = get_extension_from_content_type(content_type)
            if not extension:
                raise AssetError(f"Cannot determine file extension for {original_filename}")

        try:
            # Create asset folder
            folder = self.get_asset_folder(asset_uuid)
            folder.mkdir(parents=True, exist_ok=False)

            try:
                # Write to temp file inside folder
                with tempfile.NamedTemporaryFile(
                    mode="wb", dir=folder, delete=False, prefix=".tmp_", suffix=extension
                ) as tmp_file:
                    tmp_file.write(file_bytes)
                    tmp_path = Path(tmp_file.name)

                # Atomic rename to final location
                final_path = self.get_source_file(asset_uuid, extension)
                tmp_path.rename(final_path)

                logger.info(f"Created asset {asset_uuid}/main{extension} ({len(file_bytes)} bytes)")

                # Generate thumbnail asynchronously if image
                if extension in THUMBNAIL_FORMATS:
                    try:
                        await self.generate_thumbnail(asset_uuid, final_path)
                    except Exception as e:
                        # Thumbnail generation failure is not fatal
                        logger.warning(f"Failed to generate thumbnail for {asset_uuid}: {e}")

                return asset_uuid, extension

            except (OSError, shutil.Error):
                # Clean up folder on failure
                shutil.rmtree(folder, ignore_errors=True)
                raise

        except FileExistsError:
            raise AssetError(f"Asset UUID collision: {asset_uuid}") from None
        except PermissionDeniedError as e:
            raise AssetPermissionError(f"Permission denied creating asset: {e}") from e
        except Exception as e:
            logger.error(f"Failed to create asset: {e}", exc_info=True)
            raise AssetError(f"Failed to create asset: {e}") from e

    async def replace_asset(
        self, asset_uuid: str, file_bytes: bytes, new_filename: str, content_type: str
    ) -> tuple[str, str, bool]:
        """
        Replace an existing asset file.

        OPERATIONS:
        1. Find old source file
        2. Write new file to temp
        3. Atomic rename to new location
        4. Delete old file if extension changed
        5. Delete ALL derivatives
        6. Generate new thumbnail (if applicable)

        Returns: (new_extension, old_extension, mime_category_changed)
        """
        folder = self.get_asset_folder(asset_uuid)

        if not folder.exists():
            raise AssetMissingError(f"Asset folder not found: {asset_uuid}")

        try:
            # Find current source file
            old_source = self.find_source_file(asset_uuid)
            if not old_source:
                raise AssetMissingError(f"Asset source file not found: {asset_uuid}")

            old_extension = self.extract_extension(old_source)

            # Extract new extension
            new_path = Path(new_filename)
            new_extension = self.extract_extension(new_path)

            if not new_extension:
                new_extension = get_extension_from_content_type(content_type)
                if not new_extension:
                    raise AssetError(f"Cannot determine file extension for {new_filename}")

            # Write to temp file
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=folder, delete=False, prefix=".tmp_", suffix=new_extension
            ) as tmp_file:
                tmp_file.write(file_bytes)
                tmp_path = Path(tmp_file.name)

            # Atomic rename to final location
            final_path = self.get_source_file(asset_uuid, new_extension)
            tmp_path.rename(final_path)

            # Delete old file if extension changed
            if old_extension != new_extension and old_source.exists():
                old_source.unlink()
                logger.info(f"Deleted old source file: {old_source.name}")

            # Delete ALL derivatives (everything except the new source file)
            self._delete_derivatives(folder, asset_uuid, new_extension)

            logger.info(f"Replaced asset {asset_uuid}: {old_extension} → {new_extension}")

            # Check if MIME category changed
            mime_category_changed = self._mime_category_changed(old_extension, new_extension)

            if mime_category_changed:
                logger.warning(f"Asset {asset_uuid} MIME category changed: {old_extension} → {new_extension}")

            # Generate new thumbnail if applicable
            if new_extension in THUMBNAIL_FORMATS:
                try:
                    await self.generate_thumbnail(asset_uuid, final_path)
                except Exception as e:
                    logger.warning(f"Failed to generate thumbnail for {asset_uuid}: {e}")

            return new_extension, old_extension, mime_category_changed

        except PermissionDeniedError as e:
            raise AssetPermissionError(f"Permission denied replacing asset: {e}") from e
        except Exception as e:
            logger.error(f"Failed to replace asset {asset_uuid}: {e}", exc_info=True)
            raise AssetError(f"Failed to replace asset: {e}") from e

    def delete_asset(self, asset_uuid: str) -> bool:
        """
        Delete an asset folder.

        Returns True if successful, False if folder didn't exist.
        Logs but does not raise on deletion failures.
        """
        folder = self.get_asset_folder(asset_uuid)

        if not folder.exists():
            logger.warning(f"Asset folder not found for deletion: {asset_uuid}")
            return False

        try:
            shutil.rmtree(folder)
            logger.info(f"Deleted asset folder: {asset_uuid}")
            return True
        except PermissionDeniedError as e:
            logger.error(f"Permission denied deleting asset {asset_uuid}: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to delete asset {asset_uuid}: {e}", exc_info=True)
            return False

    async def generate_thumbnail(self, asset_uuid: str, source_path: Path) -> None:
        """
        Generate a WebP thumbnail for an image asset.

        Thumbnail is created at assets/<uuid>/thumbnail.webp
        """
        thumbnail_path = self.get_thumbnail_path(asset_uuid)

        # Run in thread pool to avoid blocking
        await asyncio.get_event_loop().run_in_executor(None, self._generate_thumbnail_sync, source_path, thumbnail_path)

    def _generate_thumbnail_sync(self, source_path: Path, thumbnail_path: Path) -> None:
        """Synchronous thumbnail generation (runs in thread pool)."""
        try:
            with Image.open(source_path) as img:
                # Convert RGBA to RGB if needed
                if img.mode in ("RGBA", "LA", "P"):
                    background = Image.new("RGB", img.size, (255, 255, 255))
                    if img.mode == "P":
                        img = img.convert("RGBA")
                    background.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
                    img = background
                elif img.mode != "RGB":
                    img = img.convert("RGB")

                # Calculate thumbnail size maintaining aspect ratio
                img.thumbnail((THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT), Image.Resampling.LANCZOS)

                # Save as WebP
                img.save(thumbnail_path, "WEBP", quality=THUMBNAIL_QUALITY, method=6)

                logger.info(f"Generated thumbnail: {thumbnail_path.name} ({img.size[0]}x{img.size[1]})")

        except Exception as e:
            logger.error(f"Failed to generate thumbnail for {source_path}: {e}")
            raise

    def _delete_derivatives(self, folder: Path, asset_uuid: str, current_extension: str) -> None:
        """Delete all files in folder except the current source file."""
        current_source = f"{asset_uuid}{current_extension}"

        for file in folder.iterdir():
            if file.is_file() and file.name != current_source:
                try:
                    file.unlink()
                    logger.info(f"Deleted derivative: {file.name}")
                except Exception as e:
                    logger.warning(f"Failed to delete derivative {file.name}: {e}")

    def _mime_category_changed(self, old_ext: str, new_ext: str) -> bool:
        """Check if MIME category changed between extensions."""
        # Find content types for extensions
        old_ct = None
        new_ct = None

        for ct, ext in ALLOWED_CONTENT_TYPES.items():
            if ext == old_ext:
                old_ct = ct
            if ext == new_ext:
                new_ct = ct

        if not old_ct or not new_ct:
            return False

        old_category = get_asset_category(old_ct)
        new_category = get_asset_category(new_ct)

        return old_category != new_category

    def verify_asset(self, asset_uuid: str) -> tuple[bool, str | None, str | None]:
        """
        Verify asset integrity.

        Returns: (is_valid, error_message, extension)
        """
        try:
            source = self.find_source_file(asset_uuid)
            if source:
                extension = self.extract_extension(source)
                return True, None, extension
            else:
                return False, "Asset folder not found", None
        except AssetInvariantViolationError as e:
            return False, str(e), None
        except Exception as e:
            return False, f"Verification failed: {e}", None


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
        self._file_service = AssetFileService(workspace_uuid)

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

        Creates the file on disk first, then creates or converts the node.  If
        ``existing_node_id`` is provided, that node is turned into an asset;
        otherwise a new node is created under ``parent_id``.
        """
        # Write file to disk first (atomic).
        asset_uuid, extension = await self._file_service.create_asset(
            file_bytes=file_bytes,
            original_filename=filename,
            content_type=content_type,
        )

        page_class_id, asset_class_id = await self._asset_repo.get_page_and_asset_class_ids(self.user_id)
        filename_without_ext = Path(filename).stem

        try:
            if existing_node_id is not None:
                node_name = content if content is not None else filename_without_ext
                await self._asset_repo.convert_node_to_asset(
                    node_id=existing_node_id,
                    asset_uuid=asset_uuid,
                    name=node_name,
                    asset_class_id=asset_class_id,
                    user_id=self.user_id,
                )
                node = await self._node_repo.get_by_id(existing_node_id)
                if node is None:
                    raise AssetError("Failed to update node to asset")
            else:
                from app.domain.entities import NodeCreateData

                data = NodeCreateData(
                    uuid=asset_uuid,
                    name=serialize_ast(parse_ast(filename_without_ext, ParseMode.PLAIN)),
                    parent_id=parent_id,
                    classes=[asset_class_id] if asset_class_id else [],
                )
                node = await self._node_repo.create(data)
        except Exception:
            # Roll back filesystem write on persistence failure.
            self._file_service.delete_asset(asset_uuid)
            raise

        if node.id is None:
            self._file_service.delete_asset(asset_uuid)
            raise AssetError("Failed to create asset node")

        source_path = self._file_service.get_source_file(asset_uuid, extension)
        return self._build_asset_dict(node, source_path, original_filename=filename)

    async def get_asset_info(self, asset_uuid: str) -> dict:
        """Return metadata for an asset node and its on-disk file."""
        node = await self._node_repo.get_by_uuid(asset_uuid)
        if node is None:
            raise AssetMissingError("Asset node not found")

        file_path = self._file_service.find_source_file(asset_uuid)
        if file_path is None:
            raise AssetMissingError("Asset file not found in folder")

        return self._build_asset_dict(node, file_path)

    async def delete_asset(self, asset_uuid: str) -> dict:
        """Delete an asset node and its on-disk folder."""
        node = await self._node_repo.get_by_uuid(asset_uuid)
        if node is None:
            raise AssetMissingError("Asset node not found")

        if node.id is not None:
            await self._node_repo.delete(node.id)

        self._file_service.delete_asset(asset_uuid)
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
            file_path = self._file_service.find_source_file(node.uuid)
            if file_path is not None and node.id is not None:
                assets.append(self._build_asset_dict(node, file_path))

        return {"assets": assets, "total": total}

    async def asset_exists(self, asset_uuid: str) -> bool:
        """Return True if an asset node with the given UUID exists."""
        return await self._asset_repo.asset_exists_by_uuid(asset_uuid)

    def get_asset_file_path(self, asset_uuid: str) -> Path | None:
        """Return the source file path for an asset, or None if missing."""
        try:
            return self._file_service.find_source_file(asset_uuid)
        except AssetInvariantViolationError:
            return None
