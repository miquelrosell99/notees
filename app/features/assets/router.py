"""Assets router - handles file uploads and downloads.

Routers are thin: validation, auth, and response formatting only. All
operation-log writes and filesystem operations are delegated to
:class:`app.features.assets.service.AssetService` via WorkspaceStore.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.config import settings
from app.dependencies import get_current_user, require_write_scope
from app.features.assets.dependencies import (
    get_asset_service,
    get_asset_service_with_token,
)
from app.features.assets.service import (
    AssetMissingError,
    AssetPermissionError,
    AssetService,
)
from app.features.assets.utils import (
    ALLOWED_CONTENT_TYPES,
    MAX_FILE_SIZE,
    check_magic_bytes,
    get_extension_from_content_type,
)
from app.logging_config import get_logger
from app.models import User

router = APIRouter(prefix="/assets", tags=["Assets"])
logger = get_logger(__name__)


_ASSET_TOKEN_LIFETIME_MINUTES = 15


def create_asset_token(asset_uuid: str, user_id: str) -> tuple[str, datetime]:
    """Create a short-lived JWT token for asset access.

    Returns the encoded token and the exact expiration datetime used for the
    JWT ``exp`` claim so callers can report the same value to clients.
    """
    expires_delta = timedelta(minutes=_ASSET_TOKEN_LIFETIME_MINUTES)
    expire = datetime.now(UTC) + expires_delta
    payload = {
        "asset_uuid": asset_uuid,
        "user_id": user_id,
        "exp": expire,
        "type": "asset_access",
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm), expire


class AssetResponse(BaseModel):
    """Response model for asset operations."""

    uuid: str
    node_uuid: str
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


@router.post("/upload", response_model=AssetResponse, dependencies=[Depends(require_write_scope)])
async def upload_asset(
    file: UploadFile = File(...),
    parent_uuid: str | None = None,
    existing_node_uuid: str | None = None,
    content: str | None = Form(None),
    asset_service: AssetService = Depends(get_asset_service),
    user: User = Depends(get_current_user),
):
    """Upload a new asset file.

    Creates a block node with the 'asset' class and stores the file in the
    workspace's assets folder content-addressed by SHA-256. If
    ``existing_node_uuid`` is provided, that node is converted to an asset
    instead of creating a new one.

    Supported file types: Images (JPEG, PNG, WebP), Audio (MP3, WAV, OGG, OPUS, WebM)
    Max file size: 50MB
    """
    content_type = file.content_type
    if content_type not in ALLOWED_CONTENT_TYPES:
        allowed_types = "Images (JPEG, PNG, WebP), Audio (MP3, WAV, OGG, OPUS, WebM)"
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {content_type}. Allowed types: {allowed_types}",
        )

    file_content = await file.read()

    if len(file_content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {MAX_FILE_SIZE // (1024 * 1024)}MB",
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
            parent_uuid=parent_uuid,
            existing_node_uuid=existing_node_uuid,
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

    token, expires_at = create_asset_token(asset_uuid, user_id)
    return AssetTokenResponse(token=token, expires_at=expires_at.isoformat())


def _parse_range_header(range_header: str, file_size: int) -> tuple[int, int] | None:
    """Parse an HTTP Range header.

    Returns (start, end) byte offsets, or None if invalid/unsupported.
    """
    if not range_header.startswith("bytes="):
        return None
    try:
        range_spec = range_header[len("bytes=") :]
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
    asset_service: AssetService = Depends(get_asset_service_with_token),
):
    """Get an asset file by its UUID.

    Supports HTTP Range requests for seekable media playback.
    Authentication: asset_token query parameter or JWT header.
    """
    try:
        if not await asset_service.asset_exists(asset_uuid):
            raise HTTPException(status_code=404, detail="Asset not found")
    except AssetPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    file_path = await asset_service.get_asset_file_path(asset_uuid)
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
    asset_service: AssetService = Depends(get_asset_service_with_token),
):
    """Get thumbnail for an image asset.

    Authentication: asset_token query parameter or JWT header.
    """
    try:
        if not await asset_service.asset_exists(asset_uuid):
            raise HTTPException(status_code=404, detail="Asset not found")
    except AssetPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    thumbnail_path = asset_service.file_service.get_thumbnail_path(asset_uuid)
    if not thumbnail_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    return FileResponse(thumbnail_path, media_type="image/webp", filename=f"{asset_uuid}_thumbnail.webp")


@router.get("/{asset_uuid}/info", response_model=AssetResponse)
async def get_asset_info(
    asset_uuid: str,
    asset_service: AssetService = Depends(get_asset_service),
    user: User = Depends(get_current_user),
):
    """Get metadata about an asset."""
    try:
        result = await asset_service.get_asset_info(asset_uuid)
    except AssetMissingError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except AssetPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Failed to get asset info: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get asset info: {e}") from e

    return AssetResponse(**result)


@router.delete("/{asset_uuid}", dependencies=[Depends(require_write_scope)])
async def delete_asset(
    asset_uuid: str,
    asset_service: AssetService = Depends(get_asset_service),
    user: User = Depends(get_current_user),
):
    """Delete an asset and its associated node."""
    try:
        result = await asset_service.delete_asset(asset_uuid)
    except AssetMissingError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except AssetPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Failed to delete asset: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete asset: {e}") from e

    return result


@router.get("/", response_model=AssetListResponse)
async def list_assets(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    asset_service: AssetService = Depends(get_asset_service),
    user: User = Depends(get_current_user),
):
    """List assets in the current workspace (paginated, max 200 per page)."""
    result = await asset_service.list_assets(page, page_size)
    return AssetListResponse(assets=[AssetResponse(**a) for a in result["assets"]], total=result["total"])
