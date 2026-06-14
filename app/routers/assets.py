"""Assets router - handles file uploads and downloads.

Routers are thin: validation, auth, and response formatting only.  All
persistence and filesystem operations are delegated to the domain AssetService.
"""

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from ..config import settings
from ..db.connection import get_workspace_uuid
from ..dependencies import (
    _get_workspace_context_cached,
    _make_asset_repository,
    _make_node_repository,
    get_asset_service,
    get_current_user,
    get_pool,
)
from ..domain.services.asset_service import (
    AssetMissingError,
    AssetPermissionError,
    AssetService,
)
from ..logging_config import get_logger
from ..models import User
from ..routers.auth import get_current_user_optional
from ..utils.assets import (
    ALLOWED_CONTENT_TYPES,
    MAX_FILE_SIZE,
    check_magic_bytes,
    get_extension_from_content_type,
)

router = APIRouter(prefix="/assets", tags=["Assets"])
logger = get_logger(__name__)


def create_asset_token(asset_uuid: str, user_id: str) -> str:
    """Create a short-lived JWT token for asset access (5 minutes)."""
    expires_delta = timedelta(minutes=5)
    expire = datetime.now(UTC) + expires_delta
    payload = {
        "asset_uuid": asset_uuid,
        "user_id": user_id,
        "exp": expire,
        "type": "asset_access",
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


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


async def _get_asset_service_for_request(
    request: Request,
    asset_token: str | None = Query(None, description="Short-lived asset access token"),
    current_user: User | None = Depends(get_current_user_optional),
) -> AsyncGenerator[AssetService, None]:
    """Build an AssetService for the user resolved from JWT/API key or asset_token."""
    user = current_user

    if not user and asset_token:
        asset_uuid = request.path_params.get("asset_uuid")
        if asset_uuid:
            user = await get_user_from_asset_token(asset_token, asset_uuid)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid or expired asset token")

    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        raise HTTPException(status_code=500, detail="Workspace UUID not found")

    asset_repo = _make_asset_repository(pool, workspace_id, user_id)
    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    yield AssetService(workspace_uuid, user_id, node_repo, asset_repo)


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


@router.post("/upload", response_model=AssetResponse)
async def upload_asset(
    file: UploadFile = File(...),
    parent_id: int | None = None,
    existing_node_id: int | None = None,
    content: str | None = Form(None),
    asset_service: AssetService = Depends(get_asset_service),
):
    """Upload a new asset file.

    Creates a node with the 'asset' type and stores the file in the workspace's
    assets folder.  If existing_node_id is provided, that node is converted to an
    asset instead of creating a new one.

    Supported file types: Images (JPEG, PNG, WebP), Audio (MP3, WAV, OGG, OPUS, WebM)
    Max file size: 50MB
    """
    content_type = file.content_type
    if content_type not in ALLOWED_CONTENT_TYPES:
        allowed_types = "Images (JPEG, PNG, WebP), Audio (MP3, WAV, OGG, OPUS, WebM)"
        raise HTTPException(
            status_code=400, detail=f"Unsupported file type: {content_type}. Allowed types: {allowed_types}"
        )

    file_content = await file.read()

    if len(file_content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400, detail=f"File too large. Maximum size is {MAX_FILE_SIZE // (1024 * 1024)}MB"
        )

    if not check_magic_bytes(file_content, content_type):
        raise HTTPException(
            status_code=400,
            detail=f"File content does not match declared type '{content_type}'. "
            "Upload rejected to prevent content-type spoofing.",
        )

    try:
        result = await asset_service.upload_asset(
            file_bytes=file_content,
            filename=file.filename or f"asset{get_extension_from_content_type(content_type)}",
            content_type=content_type,
            parent_id=parent_id,
            existing_node_id=existing_node_id,
            content=content,
        )
    except AssetPermissionError as e:
        logger.error(f"Permission error uploading asset: {e}")
        raise HTTPException(status_code=403, detail=str(e)) from e
    except AssetMissingError as e:
        logger.error(f"Asset upload referenced missing node: {e}")
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Failed to upload asset: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to upload asset: {e}") from e

    logger.info(f"Uploaded {result['category']} asset '{result['filename']}' as {result['uuid']}")
    return AssetResponse(**result)


@router.post("/{asset_uuid}/token", response_model=AssetTokenResponse)
async def generate_asset_token(
    asset_uuid: str,
    asset_service: AssetService = Depends(get_asset_service),
    current_user: User = Depends(get_current_user),
):
    """Generate a short-lived token for accessing a specific asset."""
    user_id = str(current_user.id)

    if not await asset_service.asset_exists(asset_uuid):
        raise HTTPException(status_code=404, detail="Asset not found")

    token = create_asset_token(asset_uuid, user_id)
    from datetime import UTC, datetime, timedelta

    expires_at = datetime.now(UTC) + timedelta(minutes=5)
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


def _infer_content_type(file_path: Path) -> str:
    """Infer MIME type from the file extension."""
    ext = file_path.suffix.lower()
    for ct, e in ALLOWED_CONTENT_TYPES.items():
        if e == ext or (ext == ".jpeg" and e == ".jpg"):
            return ct
    return "application/octet-stream"


@router.get("/{asset_uuid}")
async def get_asset(
    request: Request,
    asset_uuid: str,
    asset_service: AssetService = Depends(_get_asset_service_for_request),
):
    """Get an asset file by its UUID.

    Supports HTTP Range requests for seekable media playback.
    Authentication: asset_token query parameter or JWT header.
    """
    file_path = asset_service.get_asset_file_path(asset_uuid)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Asset not found")

    content_type = _infer_content_type(file_path)
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
    asset_service: AssetService = Depends(_get_asset_service_for_request),
):
    """Get thumbnail for an image asset.

    Authentication: asset_token query parameter or JWT header.
    """
    thumbnail_path = asset_service.file_service.get_thumbnail_path(asset_uuid)
    if not thumbnail_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    return FileResponse(thumbnail_path, media_type="image/webp", filename=f"{asset_uuid}_thumbnail.webp")


@router.get("/{asset_uuid}/info", response_model=AssetResponse)
async def get_asset_info(
    asset_uuid: str,
    asset_service: AssetService = Depends(get_asset_service),
):
    """Get metadata about an asset."""
    try:
        result = await asset_service.get_asset_info(asset_uuid)
    except AssetMissingError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Failed to get asset info: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get asset info: {e}") from e

    return AssetResponse(**result)


@router.delete("/{asset_uuid}")
async def delete_asset(
    asset_uuid: str,
    asset_service: AssetService = Depends(get_asset_service),
):
    """Delete an asset and its associated node."""
    try:
        result = await asset_service.delete_asset(asset_uuid)
    except AssetMissingError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Failed to delete asset: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete asset: {e}") from e

    return result


@router.get("/", response_model=AssetListResponse)
async def list_assets(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    asset_service: AssetService = Depends(get_asset_service),
):
    """List assets in the current workspace (paginated, max 200 per page)."""
    result = await asset_service.list_assets(page, page_size)
    return AssetListResponse(assets=[AssetResponse(**a) for a in result["assets"]], total=result["total"])
