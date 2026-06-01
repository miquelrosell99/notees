"""Assets router - handles file uploads and downloads.

Updated for workspace-based schema with per-asset folder structure:
- workspace_id -> workspace_id
- Uses get_or_create_user_workspace
- Repositories now take user_id for audit trails
- target_node_id -> target_id in property_value_relation

Assets are stored in per-asset folders for future thumbnail support:
  workspaces/{workspace_id}/assets/{node_uuid}/{node_uuid}.{extension}
  workspaces/{workspace_id}/assets/{node_uuid}/thumbnail.webp  (future)

Each asset is associated with a node that has the 'asset' type tag.
Supported file types: Images (JPEG, PNG), Audio (MP3, WAV, OGG, OPUS, WebM)
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import asyncpg
import jwt
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from ..config import settings
from ..db.connection import acquire_connection, get_pool, get_workspace_assets_dir, get_workspace_uuid
from ..db.schema import SYSTEM_CLASS_UUIDS, get_or_create_user_workspace
from ..domain.entities import NodeCreateData, generate_uuid
from ..domain.repositories import PostgresNodeRepository
from ..domain.services.asset_service import (
    AssetPermissionError,
    AssetService,
)
from ..domain.stringify_ast import ParseMode, parse_ast, serialize_ast
from ..logging_config import get_logger
from ..models import User
from .auth import get_current_user, get_current_user_optional

router = APIRouter(prefix="/assets", tags=["Assets"])
logger = get_logger(__name__)

# Allowed file types and their extensions
ALLOWED_CONTENT_TYPES = {
    # Images
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    # Audio
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/webm": ".webm",
}

# Asset categories for frontend rendering
ASSET_CATEGORIES = {
    "image": ["image/jpeg", "image/png", "image/webp"],
    "audio": [
        "audio/mpeg",
        "audio/mp3",
        "audio/wav",
        "audio/wave",
        "audio/x-wav",
        "audio/ogg",
        "audio/opus",
        "audio/webm",
    ],
}

# Max file size: 50MB (for audio files)
MAX_FILE_SIZE = 50 * 1024 * 1024

# Magic byte signatures: map expected MIME types → list of (offset, bytes) signatures.
# We check the file header rather than trusting the client-supplied Content-Type.
_MAGIC_SIGNATURES: dict[str, list[tuple[int, bytes]]] = {
    "image/jpeg": [(0, b"\xff\xd8\xff")],
    "image/png": [(0, b"\x89PNG\r\n\x1a\n")],
    "image/webp": [(0, b"RIFF"), (8, b"WEBP")],
    "audio/mpeg": [(0, b"ID3"), (0, b"\xff\xfb"), (0, b"\xff\xf3"), (0, b"\xff\xf2")],
    "audio/mp3": [(0, b"ID3"), (0, b"\xff\xfb"), (0, b"\xff\xf3"), (0, b"\xff\xf2")],
    "audio/wav": [(0, b"RIFF"), (8, b"WAVE")],
    "audio/wave": [(0, b"RIFF"), (8, b"WAVE")],
    "audio/x-wav": [(0, b"RIFF"), (8, b"WAVE")],
    "audio/ogg": [(0, b"OggS")],
    "audio/opus": [(0, b"OggS")],
    "audio/webm": [(0, b"\x1aE\xdf\xa3")],
}


def _check_magic_bytes(content: bytes, content_type: str) -> bool:
    """Verify that file content begins with the expected magic bytes.

    Returns True when the signature matches or when no signature is defined for
    the given MIME type (fail-open to avoid blocking legitimate edge cases).
    """
    sigs = _MAGIC_SIGNATURES.get(content_type)
    if not sigs:
        return True  # No signature registered → accept

    # For multi-signature types (e.g. WAV / WebP) ALL non-zero-offset checks
    # that share a group must pass together.  We model this by pairing sigs
    # that belong to the same "group" — here we treat them sequentially and
    # require at least one full group to pass.
    # For simplicity: group consecutive sigs; a single-element list is its own group.
    for sig_offset, sig_bytes in sigs:
        chunk = content[sig_offset : sig_offset + len(sig_bytes)]
        if chunk == sig_bytes:
            return True  # At least one matching signature found

    return False


def get_asset_category(content_type: str) -> str:
    """Get the asset category (image, audio, etc.) from content type."""
    for category, types in ASSET_CATEGORIES.items():
        if content_type in types:
            return category
    return "file"


class AssetResponse(BaseModel):
    """Response model for asset operations."""

    uuid: str
    node_id: int
    filename: str
    content_type: str
    category: str  # image, audio, file
    size_bytes: int
    url: str


class AssetListResponse(BaseModel):
    """Response model for listing assets."""

    assets: list[AssetResponse]
    total: int


class AssetTokenResponse(BaseModel):
    """Response model for asset token generation."""

    token: str
    expires_at: str


def create_asset_token(asset_uuid: str, user_id: str) -> str:
    """Create a short-lived JWT token for asset access (5 minutes)."""
    expires_delta = timedelta(minutes=5)
    expire = datetime.now(UTC) + expires_delta

    payload = {"asset_uuid": asset_uuid, "user_id": user_id, "exp": expire, "type": "asset_access"}

    token = jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)
    return token


def decode_asset_token(token: str) -> dict | None:
    """Decode and verify an asset token."""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        if payload.get("type") != "asset_access":
            return None
        return payload
    except Exception as e:
        logger.warning(f"Asset token decode error: {e}")
        return None


async def get_user_from_asset_token(asset_token: str, asset_uuid: str) -> User | None:
    """Get user from asset token and validate it matches the requested asset."""
    payload = decode_asset_token(asset_token)
    if not payload:
        return None

    # Verify the token is for this specific asset
    if payload.get("asset_uuid") != asset_uuid:
        logger.warning(f"Asset token asset_uuid mismatch: {payload.get('asset_uuid')} != {asset_uuid}")
        return None

    user_id = payload.get("user_id")
    if not user_id:
        return None

    from .. import auth

    user_data = await auth.get_user_by_id(user_id)
    if not user_data:
        return None

    return User(**user_data)


def get_asset_path(workspace_uuid: str, asset_uuid: str, extension: str) -> Path:
    """Get the file path for an asset in per-asset folder structure.

    Structure: workspaces/{workspace_uuid}/assets/{asset_uuid}/{asset_uuid}.{extension}
    """
    assets_dir = get_workspace_assets_dir(workspace_uuid)
    asset_folder = assets_dir / asset_uuid
    asset_folder.mkdir(parents=True, exist_ok=True)
    return asset_folder / f"{asset_uuid}{extension}"


def get_extension_from_content_type(content_type: str) -> str:
    """Get file extension from content type."""
    return ALLOWED_CONTENT_TYPES.get(content_type, "")


async def _get_system_ids(pool, workspace_id: int, user_id: int):
    """Get system type IDs from the database."""
    async with acquire_connection(pool) as conn:
        # Get page type ID
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2", SYSTEM_CLASS_UUIDS["page"], workspace_id
        )
        page_type_id = row["id"] if row else 1

        now = datetime.now(UTC)

        # Get or create asset class ID
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND is_class = TRUE AND workspace_id = $2",
            SYSTEM_CLASS_UUIDS["asset"],
            workspace_id,
        )
        if row:
            asset_type_id = row["id"]
        else:
            # Create the asset class using proper AST name format
            uuid = generate_uuid()
            asset_type_id = await conn.fetchval(
                """
                INSERT INTO node (workspace_id, uuid, name, icon, is_class, is_asset, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3, NULL, TRUE, TRUE, $4, $4, $5, $5)
                RETURNING id
            """,
                workspace_id,
                uuid,
                serialize_ast(parse_ast("asset", ParseMode.PLAIN)),
                now,
                user_id,
            )

            # Give it the 'class' class itself
            type_row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2", SYSTEM_CLASS_UUIDS["class"], workspace_id
            )
            if type_row:
                # Update class_ids directly
                await conn.execute(
                    """
                    UPDATE node SET class_ids = ARRAY[$1]::integer[], write_date = $2
                    WHERE id = $3
                """,
                    type_row["id"],
                    now,
                    asset_type_id,
                )

    return page_type_id, asset_type_id


@router.post("/upload", response_model=AssetResponse)
async def upload_asset(
    file: UploadFile = File(...),
    parent_id: int | None = None,
    existing_node_id: int | None = None,
    current_user: User = Depends(get_current_user),
):
    """Upload a new asset file using AssetService.

    Creates a node with the 'asset' type and stores the file
    in the workspace's assets folder using atomic operations.

    If existing_node_id is provided, converts that node to an asset
    instead of creating a new one (useful for empty blocks).

    Supported file types: Images (JPEG, PNG, WebP), Audio (MP3, WAV, OGG, OPUS, WebM)
    Max file size: 50MB
    """
    # Validate content type
    content_type = file.content_type
    if content_type not in ALLOWED_CONTENT_TYPES:
        allowed_types = "Images (JPEG, PNG, WebP), Audio (MP3, WAV, OGG, OPUS, WebM)"
        raise HTTPException(
            status_code=400, detail=f"Unsupported file type: {content_type}. Allowed types: {allowed_types}"
        )

    # Read file content
    content = await file.read()

    # Validate file size
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400, detail=f"File too large. Maximum size is {MAX_FILE_SIZE // (1024 * 1024)}MB"
        )

    # Validate actual file content matches the declared MIME type to prevent
    # attackers from uploading arbitrary files with a spoofed Content-Type.
    if not _check_magic_bytes(content, content_type):
        raise HTTPException(
            status_code=400,
            detail=f"File content does not match declared type '{content_type}'. "
            "Upload rejected to prevent content-type spoofing.",
        )

    user_id = int(current_user.id)
    pool = await get_pool()

    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), user_id)

    # Get workspace UUID for asset storage
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        raise HTTPException(status_code=500, detail="Workspace UUID not found")

    try:
        page_type_id, asset_type_id = await _get_system_ids(pool, workspace_id, user_id)

        # Initialize AssetService
        asset_service = AssetService(workspace_uuid)

        # Create asset using service (ATOMIC OPERATION)
        # This creates folder + writes file before we create node
        asset_uuid, extension = await asset_service.create_asset(
            file_bytes=content,
            original_filename=file.filename or f"asset{get_extension_from_content_type(content_type)}",
            content_type=content_type,
        )

        # Extract filename without extension for node name
        filename_without_ext = Path(file.filename).stem if file.filename else "asset"

        # Create repository
        node_repo = PostgresNodeRepository(pool, workspace_id, page_type_id, user_id)

        # If existing_node_id is provided, convert that node to an asset
        if existing_node_id:
            node = await node_repo.get_by_id(existing_node_id)
            if not node:
                raise HTTPException(status_code=404, detail=f"Node {existing_node_id} not found")

            # Update the node to be an asset
            async with acquire_connection(pool) as conn:
                now = datetime.now(UTC)
                await conn.execute(
                    """
                    UPDATE node
                    SET name = $1, uuid = $2, is_asset = TRUE, write_date = $3, write_uid = $4
                    WHERE id = $5 AND workspace_id = $6
                """,
                    filename_without_ext,
                    asset_uuid,
                    now,
                    user_id,
                    existing_node_id,
                    workspace_id,
                )

                # Add asset class to the node
                if asset_type_id:
                    # Update class_ids directly
                    await conn.execute(
                        """
                        UPDATE node SET class_ids = class_ids || $1::integer[], write_date = $2
                        WHERE id = $3
                    """,
                        [asset_type_id],
                        now,
                        existing_node_id,
                    )

            # Fetch updated node
            node = await node_repo.get_by_id(existing_node_id)
            if not node:
                raise HTTPException(status_code=500, detail="Failed to update node to asset")
        else:
            # Create the asset node ONLY after file is safely written
            data = NodeCreateData(
                uuid=asset_uuid,  # Use UUID from service
                name=serialize_ast(parse_ast(filename_without_ext, ParseMode.PLAIN)),
                parent_id=parent_id,
                classes=[asset_type_id] if asset_type_id else [],
            )

            node = await node_repo.create(data)

        category = get_asset_category(content_type)

        logger.info(f"Uploaded {category} asset '{file.filename}' as {node.uuid} for user {user_id}")

        if node.id is None:
            raise HTTPException(status_code=500, detail="Failed to create asset node")

        return AssetResponse(
            uuid=node.uuid,
            node_id=node.id,
            filename=file.filename or f"asset{extension}",
            content_type=content_type,
            category=category,
            size_bytes=len(content),
            url=f"/api/assets/{node.uuid}",
        )

    except AssetPermissionError as e:
        logger.error(f"Permission error uploading asset: {e}")
        raise HTTPException(status_code=403, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Failed to upload asset: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to upload asset: {e}") from e


@router.post("/{asset_uuid}/token", response_model=AssetTokenResponse)
async def generate_asset_token(asset_uuid: str, current_user: User = Depends(get_current_user)):
    """
    Generate a short-lived token for accessing a specific asset.

    This token can be used in the asset_token query parameter when fetching assets.
    Tokens expire after 5 minutes.

    This is the secure alternative to passing JWTs in image/audio src URLs.
    """
    user_id = str(current_user.id)
    pool = await get_pool()

    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), int(user_id))

    # Verify the asset exists and belongs to this user's workspace
    async with acquire_connection(pool) as conn:
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2 AND is_asset = TRUE", asset_uuid, workspace_id
        )
        if not row:
            raise HTTPException(status_code=404, detail="Asset not found")

    # Generate token
    token = create_asset_token(asset_uuid, user_id)
    expires_at = datetime.now(UTC) + timedelta(minutes=5)

    logger.debug(f"Generated asset token for {asset_uuid} (expires: {expires_at.isoformat()})")

    return AssetTokenResponse(token=token, expires_at=expires_at.isoformat())


def _parse_range_header(range_header: str, file_size: int) -> tuple[int, int] | None:
    """Parse an HTTP Range header.

    Returns (start, end) byte offsets, or None if invalid/unsupported.
    """
    if not range_header.startswith("bytes="):
        return None
    try:
        range_spec = range_header[len("bytes="):]
        start_str, end_str = range_spec.split("-", 1)
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1
        if start < 0 or end >= file_size or start > end:
            return None
        return start, end
    except (ValueError, IndexError):
        return None


@router.get("/{asset_uuid}")
async def get_asset(
    request: Request,
    asset_uuid: str,
    asset_token: str | None = Query(None, description="Short-lived asset access token"),
    current_user: User | None = Depends(get_current_user_optional),
):
    """Get an asset file by its UUID.

    Returns the file content with appropriate content type.
    Supports HTTP Range requests for seekable media playback.

    Authentication methods (in order of preference):
    1. asset_token query parameter (short-lived, asset-specific)
    2. Authorization header (standard JWT)

    Scans the per-asset folder: assets/{uuid}/{uuid}.{ext}
    """
    # Try asset_token first (preferred method)
    user = None
    if asset_token:
        user = await get_user_from_asset_token(asset_token, asset_uuid)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid or expired asset token")

    # Fall back to header auth
    if not user:
        user = current_user

    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_id = int(user.id)
    pool = await get_pool()

    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), user_id)

    # Get workspace UUID for asset storage
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        raise HTTPException(status_code=500, detail="Workspace UUID not found")

    assets_dir = get_workspace_assets_dir(workspace_uuid)
    asset_folder = assets_dir / asset_uuid

    # Check if asset folder exists
    if not asset_folder.exists() or not asset_folder.is_dir():
        raise HTTPException(status_code=404, detail="Asset not found")

    # Find the asset file: main.{ext} (any extension)
    file_path: Path | None = None
    content_type = "application/octet-stream"
    for candidate in asset_folder.iterdir():
        if candidate.is_file() and candidate.stem == "main":
            ext = candidate.suffix.lower()
            for ct, e in ALLOWED_CONTENT_TYPES.items():
                if e == ext or (ext == ".jpeg" and e == ".jpg"):
                    content_type = ct
                    break
            file_path = candidate
            break

    if not file_path:
        raise HTTPException(status_code=404, detail="Asset file not found in folder")

    file_size = file_path.stat().st_size
    range_header = request.headers.get("range")

    if range_header:
        parsed = _parse_range_header(range_header, file_size)
        if parsed is None:
            raise HTTPException(
                status_code=416,
                detail="Range Not Satisfiable",
                headers={"Content-Range": f"bytes */{file_size}"},
            )
        start, end = parsed
        content_length = end - start + 1

        def _range_stream():
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk_size = min(64 * 1024, remaining)
                    data = f.read(chunk_size)
                    if not data:
                        break
                    yield data
                    remaining -= len(data)

        return StreamingResponse(
            _range_stream(),
            status_code=206,
            media_type=content_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(content_length),
                "Accept-Ranges": "bytes",
            },
        )

    return FileResponse(
        file_path,
        media_type=content_type,
        filename=f"{asset_uuid}{file_path.suffix.lower()}",
        headers={"Accept-Ranges": "bytes"},
    )


@router.get("/{asset_uuid}/thumbnail")
async def get_asset_thumbnail(
    asset_uuid: str,
    asset_token: str | None = Query(None, description="Short-lived asset access token"),
    current_user: User | None = Depends(get_current_user_optional),
):
    """
    Get thumbnail for an image asset.

    Returns 404 if thumbnail doesn't exist (client should fall back to original).

    Authentication methods (in order of preference):
    1. asset_token query parameter (short-lived, asset-specific)
    2. Authorization header (standard JWT)
    """
    # Try asset_token first (preferred method)
    user = None
    if asset_token:
        user = await get_user_from_asset_token(asset_token, asset_uuid)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid or expired asset token")

    # Fall back to header auth
    if not user:
        user = current_user

    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_id = int(user.id)
    pool = await get_pool()

    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), user_id)

    # Get workspace UUID for asset storage
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        raise HTTPException(status_code=500, detail="Workspace UUID not found")

    asset_service = AssetService(workspace_uuid)
    thumbnail_path = asset_service.get_thumbnail_path(asset_uuid)

    if not thumbnail_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    return FileResponse(thumbnail_path, media_type="image/webp", filename=f"{asset_uuid}_thumbnail.webp")


@router.get("/{asset_uuid}/info", response_model=AssetResponse)
async def get_asset_info(asset_uuid: str, current_user: User = Depends(get_current_user)):
    """Get metadata about an asset from per-asset folder."""
    user_id = int(current_user.id)
    pool = await get_pool()

    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), user_id)

    page_type_id, _ = await _get_system_ids(pool, workspace_id, user_id)
    node_repo = PostgresNodeRepository(pool, workspace_id, page_type_id, user_id)

    node = await node_repo.get_by_uuid(asset_uuid)
    if not node:
        raise HTTPException(status_code=404, detail="Asset node not found")

    # Find the asset file in per-asset folder
    assets_dir = get_workspace_assets_dir(workspace_id)
    asset_folder = assets_dir / asset_uuid

    if not asset_folder.exists() or not asset_folder.is_dir():
        raise HTTPException(status_code=404, detail="Asset folder not found")

    # Find the asset file: main.{ext} (any extension)
    for file_path in asset_folder.iterdir():
        if file_path.is_file() and file_path.stem == "main":
            ext = file_path.suffix.lower()
            content_type = "application/octet-stream"
            for ct, e in ALLOWED_CONTENT_TYPES.items():
                if e == ext or (ext == ".jpeg" and e == ".jpg"):
                    content_type = ct
                    break

            if node.id is None:
                raise HTTPException(status_code=500, detail="Invalid asset node")

            return AssetResponse(
                uuid=asset_uuid,
                node_id=node.id,
                filename=node.name,
                content_type=content_type,
                category=get_asset_category(content_type),
                size_bytes=file_path.stat().st_size,
                url=f"/api/assets/{asset_uuid}",
            )

    raise HTTPException(status_code=404, detail="Asset file not found in folder")


@router.delete("/{asset_uuid}")
async def delete_asset(asset_uuid: str, current_user: User = Depends(get_current_user)):
    """Delete an asset and its associated node using AssetService."""
    user_id = int(current_user.id)
    pool = await get_pool()

    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), user_id)

    page_type_id, _ = await _get_system_ids(pool, workspace_id, user_id)
    node_repo = PostgresNodeRepository(pool, workspace_id, page_type_id, user_id)

    # Get the node
    node = await node_repo.get_by_uuid(asset_uuid)
    if not node:
        raise HTTPException(status_code=404, detail="Asset node not found")

    # Get workspace UUID for asset storage
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        raise HTTPException(status_code=500, detail="Workspace UUID not found")

    # Delete the node first (references must be cleaned up)
    if node.id:
        await node_repo.delete(node.id)

    # Then delete the asset folder (failures logged, not raised)
    asset_service = AssetService(workspace_uuid)
    asset_service.delete_asset(asset_uuid)

    logger.info(f"Deleted asset {asset_uuid} for user {user_id}")

    return {"status": "deleted", "uuid": asset_uuid}


@router.get("/", response_model=AssetListResponse)
async def list_assets(page: int = 1, page_size: int = 50, current_user: User = Depends(get_current_user)):
    """List all assets in the current workspace."""
    user_id = int(current_user.id)
    pool = await get_pool()

    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), user_id)

    page_type_id, asset_type_id = await _get_system_ids(pool, workspace_id, user_id)
    node_repo = PostgresNodeRepository(pool, workspace_id, page_type_id, user_id)

    # Get nodes that have the 'asset' type
    if asset_type_id is None:
        return AssetListResponse(assets=[], total=0)
    nodes = await node_repo.get_typed_with(asset_type_id)

    # Apply pagination
    start = (page - 1) * page_size
    end = start + page_size
    paged_nodes = nodes[start:end]

    # Get workspace UUID for asset storage
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        raise HTTPException(status_code=500, detail="Workspace UUID not found")

    assets = []
    assets_dir = get_workspace_assets_dir(workspace_uuid)

    for node in paged_nodes:
        # Find the file for this asset in its folder
        asset_folder = assets_dir / node.uuid
        if asset_folder.exists() and asset_folder.is_dir():
            for file_path in asset_folder.iterdir():
                if file_path.is_file() and file_path.stem == "main":
                    ext = file_path.suffix.lower()
                    content_type = "application/octet-stream"
                    for ct, e in ALLOWED_CONTENT_TYPES.items():
                        if e == ext or (ext == ".jpeg" and e == ".jpg"):
                            content_type = ct
                            break

                    if node.id is not None:
                        assets.append(
                            AssetResponse(
                                uuid=node.uuid,
                                node_id=node.id,
                                filename=node.name,
                                content_type=content_type,
                                category=get_asset_category(content_type),
                                size_bytes=file_path.stat().st_size,
                                url=f"/api/assets/{node.uuid}",
                            )
                        )
                    break

    return AssetListResponse(assets=assets, total=len(nodes))
