"""Assets router - handles file uploads and downloads.

Assets are stored as files in workspace's assets folder:
  workspaces/{workspace_id}/assets/{node_uuid}.{extension}

Each asset is associated with a node that has the 'asset' type tag.
Supported file types: Images (JPEG, PNG), Audio (MP3, WAV, OGG, OPUS, WebM)
"""
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, List
from pathlib import Path
import uuid as uuid_module
from datetime import datetime, timezone

from ..db.connection import get_pool, get_workspace_assets_dir
from ..db.schema import get_or_create_user_workspace, SYSTEM_TYPE_UUIDS, SYSTEM_PROPERTY_UUIDS
from ..domain.entities import NodeCreateData
from ..domain.repositories import PostgresNodeRepository, PostgresLinkRepository, PostgresPropertyRepository
from ..domain.services import NodeService, LinkParsingService
from .auth import get_current_user, get_current_user_optional
from ..models import User
from ..logging_config import get_logger

router = APIRouter(prefix="/api/assets", tags=["Assets"])
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
    "audio": ["audio/mpeg", "audio/mp3", "audio/wav", "audio/wave", "audio/x-wav", "audio/ogg", "audio/opus", "audio/webm"],
}

# Max file size: 50MB (for audio files)
MAX_FILE_SIZE = 50 * 1024 * 1024


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
    assets: List[AssetResponse]
    total: int


def get_asset_path(workspace_id: int, asset_uuid: str, extension: str) -> Path:
    """Get the file path for an asset."""
    assets_dir = get_workspace_assets_dir(workspace_id)
    return assets_dir / f"{asset_uuid}{extension}"


def get_extension_from_content_type(content_type: str) -> str:
    """Get file extension from content type."""
    return ALLOWED_CONTENT_TYPES.get(content_type, "")


async def _get_system_ids(pool, workspace_id: int):
    """Get system type IDs from the database."""
    async with pool.acquire() as conn:
        # Get page type ID
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
            SYSTEM_TYPE_UUIDS['page'], workspace_id
        )
        page_type_id = row['id'] if row else 1
        
        # Get types property ID
        row = await conn.fetchrow(
            "SELECT id FROM property WHERE uuid = $1",
            SYSTEM_PROPERTY_UUIDS['types']
        )
        types_property_id = row['id'] if row else 1
        
        # Get or create asset type ID
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE name = 'asset' AND is_type = TRUE AND workspace_id = $1",
            workspace_id
        )
        if row:
            asset_type_id = row['id']
        else:
            # Create the asset type
            now = datetime.now(timezone.utc)
            uuid = str(uuid_module.uuid4())
            asset_type_id = await conn.fetchval("""
                INSERT INTO node (workspace_id, uuid, name, icon, is_type, is_asset, create_date, write_date)
                VALUES ($1, $2, 'asset', NULL, TRUE, TRUE, $3, $3)
                RETURNING id
            """, workspace_id, uuid, now)
            
            # Give it the 'type' type itself
            type_row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
                SYSTEM_TYPE_UUIDS['type'], workspace_id
            )
            if type_row:
                # Create node_property assignment first
                np_id = await conn.fetchval("""
                    INSERT INTO node_property (node_id, property_id, create_date, write_date)
                    VALUES ($1, $2, $3, $3)
                    RETURNING id
                """, asset_type_id, types_property_id, now)
                
                # Add type value to property_value_relation
                await conn.execute("""
                    INSERT INTO property_value_relation 
                        (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
                    VALUES ($1, $2, $3, $4, 0, $5, $5)
                """, np_id, types_property_id, asset_type_id, type_row['id'], now)
    
    return page_type_id, types_property_id, asset_type_id


@router.post("/upload", response_model=AssetResponse)
async def upload_asset(
    file: UploadFile = File(...),
    parent_id: Optional[int] = None,
    current_user: User = Depends(get_current_user)
):
    """Upload a new asset file.
    
    Creates a node with the 'asset' type and stores the file
    in the workspace's assets folder.
    
    Supported file types: Images (JPEG, PNG, WebP), Audio (MP3, WAV, OGG, OPUS, WebM)
    Max file size: 50MB
    """
    # Validate content type
    content_type = file.content_type
    if content_type not in ALLOWED_CONTENT_TYPES:
        allowed_types = "Images (JPEG, PNG, WebP), Audio (MP3, WAV, OGG, OPUS, WebM)"
        raise HTTPException(
            status_code=400, 
            detail=f"Unsupported file type: {content_type}. Allowed types: {allowed_types}"
        )
    
    # Read file content
    content = await file.read()
    
    # Validate file size
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {MAX_FILE_SIZE // (1024 * 1024)}MB"
        )
    
    user_id = current_user.id
    pool = await get_pool()
    workspace_id = await get_or_create_user_workspace(pool, user_id)
    
    try:
        page_type_id, types_property_id, asset_type_id = await _get_system_ids(pool, workspace_id)
        
        # Get file extension and category
        extension = get_extension_from_content_type(content_type)
        category = get_asset_category(content_type)
        
        # Create repository
        node_repo = PostgresNodeRepository(pool, workspace_id)
        
        # Create the asset node with 'asset' type
        data = NodeCreateData(
            name=file.filename or f"asset{extension}",
            parent_id=parent_id,
            types=[asset_type_id] if asset_type_id else [],
            is_asset=True,
        )
        
        node = await node_repo.create(data)
        
        # Save file to assets directory using node UUID
        asset_path = get_asset_path(workspace_id, node.uuid, extension)
        asset_path.write_bytes(content)
        
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
            url=f"/api/assets/{node.uuid}"
        )
        
    except Exception as e:
        logger.error(f"Failed to upload asset: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to upload asset: {e}")


async def get_user_from_token_param(token: Optional[str] = None) -> Optional[User]:
    """Get user from token query parameter (for img/audio src URLs)."""
    if not token:
        return None
    from .. import auth
    payload = auth.decode_token(token)
    if not payload:
        return None
    user_id = payload.get("user_id")
    if not user_id:
        return None
    user_data = await auth.get_user_by_id(user_id)
    if not user_data:
        return None
    return User(**user_data)


@router.get("/{asset_uuid}")
async def get_asset(
    asset_uuid: str,
    token: Optional[str] = None,
    current_user: Optional[User] = Depends(get_current_user_optional)
):
    """Get an asset file by its UUID.
    
    Returns the file content with appropriate content type.
    Accepts authentication via Authorization header or token query parameter
    (needed for img/audio src URLs which don't send headers).
    """
    # Try token param first (for img/audio src), fall back to header auth
    user = await get_user_from_token_param(token) if token else None
    if not user:
        user = current_user
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    user_id = user.id
    pool = await get_pool()
    workspace_id = await get_or_create_user_workspace(pool, user_id)
    assets_dir = get_workspace_assets_dir(workspace_id)
    
    # Find the asset file (we don't know the extension)
    for ext in ALLOWED_CONTENT_TYPES.values():
        asset_path = assets_dir / f"{asset_uuid}{ext}"
        if asset_path.exists():
            # Determine content type from extension
            content_type = "application/octet-stream"
            for ct, e in ALLOWED_CONTENT_TYPES.items():
                if e == ext:
                    content_type = ct
                    break
            
            return FileResponse(
                asset_path,
                media_type=content_type,
                filename=f"{asset_uuid}{ext}"
            )
    
    raise HTTPException(status_code=404, detail="Asset not found")


@router.get("/{asset_uuid}/info", response_model=AssetResponse)
async def get_asset_info(
    asset_uuid: str,
    current_user: User = Depends(get_current_user)
):
    """Get metadata about an asset."""
    user_id = current_user.id
    pool = await get_pool()
    workspace_id = await get_or_create_user_workspace(pool, user_id)
    
    page_type_id, types_property_id, _ = await _get_system_ids(pool, workspace_id)
    node_repo = PostgresNodeRepository(pool, workspace_id)
    
    node = await node_repo.get_by_uuid(asset_uuid)
    if not node:
        raise HTTPException(status_code=404, detail="Asset node not found")
    
    # Find the asset file
    assets_dir = get_workspace_assets_dir(workspace_id)
    for ext in ALLOWED_CONTENT_TYPES.values():
        asset_path = assets_dir / f"{asset_uuid}{ext}"
        if asset_path.exists():
            content_type = "application/octet-stream"
            for ct, e in ALLOWED_CONTENT_TYPES.items():
                if e == ext:
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
                size_bytes=asset_path.stat().st_size,
                url=f"/api/assets/{asset_uuid}"
            )
    
    raise HTTPException(status_code=404, detail="Asset file not found")


@router.delete("/{asset_uuid}")
async def delete_asset(
    asset_uuid: str,
    current_user: User = Depends(get_current_user)
):
    """Delete an asset and its associated node."""
    user_id = current_user.id
    pool = await get_pool()
    workspace_id = await get_or_create_user_workspace(pool, user_id)
    
    page_type_id, types_property_id, _ = await _get_system_ids(pool, workspace_id)
    node_repo = PostgresNodeRepository(pool, workspace_id)
    
    node = await node_repo.get_by_uuid(asset_uuid)
    if not node:
        raise HTTPException(status_code=404, detail="Asset node not found")
    
    # Delete the file first
    assets_dir = get_workspace_assets_dir(workspace_id)
    deleted_file = False
    for ext in ALLOWED_CONTENT_TYPES.values():
        asset_path = assets_dir / f"{asset_uuid}{ext}"
        if asset_path.exists():
            asset_path.unlink()
            deleted_file = True
            break
    
    # Soft delete the node
    if node.id is None:
        raise HTTPException(status_code=500, detail="Invalid asset node")
    await node_repo.delete(node.id)
    
    logger.info(f"Deleted asset {asset_uuid} for user {user_id}")
    
    return {"success": True, "deleted_file": deleted_file}


@router.get("/", response_model=AssetListResponse)
async def list_assets(
    page: int = 1,
    page_size: int = 50,
    current_user: User = Depends(get_current_user)
):
    """List all assets in the current workspace."""
    user_id = current_user.id
    pool = await get_pool()
    workspace_id = await get_or_create_user_workspace(pool, user_id)
    
    page_type_id, types_property_id, asset_type_id = await _get_system_ids(pool, workspace_id)
    node_repo = PostgresNodeRepository(pool, workspace_id)
    
    # Get nodes that have the 'asset' type
    if asset_type_id is None:
        return AssetListResponse(assets=[], total=0)
    nodes = await node_repo.get_typed_with(asset_type_id)
    
    # Apply pagination
    start = (page - 1) * page_size
    end = start + page_size
    paged_nodes = nodes[start:end]
    
    assets = []
    assets_dir = get_workspace_assets_dir(workspace_id)
    
    for node in paged_nodes:
        # Find the file for this asset
        for ext in ALLOWED_CONTENT_TYPES.values():
            asset_path = assets_dir / f"{node.uuid}{ext}"
            if asset_path.exists():
                content_type = "application/octet-stream"
                for ct, e in ALLOWED_CONTENT_TYPES.items():
                    if e == ext:
                        content_type = ct
                        break
                
                if node.id is not None:
                    assets.append(AssetResponse(
                        uuid=node.uuid,
                        node_id=node.id,
                        filename=node.name,
                        content_type=content_type,
                        category=get_asset_category(content_type),
                        size_bytes=asset_path.stat().st_size,
                        url=f"/api/assets/{node.uuid}"
                    ))
                break
    
    return AssetListResponse(assets=assets, total=len(nodes))
