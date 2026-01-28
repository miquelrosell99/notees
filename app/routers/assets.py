"""Assets router - handles file uploads and downloads.

Updated for graph-based schema with per-asset folder structure:
- workspace_id -> graph_id
- Uses get_or_create_user_graph
- Repositories now take user_id for audit trails
- target_node_id -> target_id in property_value_relation

Assets are stored in per-asset folders for future thumbnail support:
  graphs/{graph_id}/assets/{node_uuid}/{node_uuid}.{extension}
  graphs/{graph_id}/assets/{node_uuid}/thumbnail.webp  (future)

Each asset is associated with a node that has the 'asset' type tag.
Supported file types: Images (JPEG, PNG), Audio (MP3, WAV, OGG, OPUS, WebM)
"""
from typing import cast, Optional, List
from pathlib import Path
from datetime import datetime, timezone
import uuid as uuid_module

import asyncpg
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..db.connection import get_pool, get_graph_assets_dir
from ..db.schema import get_or_create_user_graph, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from ..domain.entities import NodeCreateData, generate_uuid
from ..domain.repositories import PostgresNodeRepository, PostgresLinkRepository, PostgresPropertyRepository
from ..domain.services import NodeService, LinkParsingService
from ..domain.services.asset_service import AssetService, AssetMissingError, AssetPermissionError, AssetInvariantViolation
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


def get_asset_path(graph_id: int, asset_uuid: str, extension: str) -> Path:
    """Get the file path for an asset in per-asset folder structure.
    
    Structure: graphs/{graph_id}/assets/{asset_uuid}/{asset_uuid}.{extension}
    """
    assets_dir = get_graph_assets_dir(graph_id)
    asset_folder = assets_dir / asset_uuid
    asset_folder.mkdir(parents=True, exist_ok=True)
    return asset_folder / f"{asset_uuid}{extension}"


def get_extension_from_content_type(content_type: str) -> str:
    """Get file extension from content type."""
    return ALLOWED_CONTENT_TYPES.get(content_type, "")


async def _get_system_ids(pool, graph_id: int, user_id: int):
    """Get system type IDs from the database."""
    async with pool.acquire() as conn:
        # Get page type ID
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND graph_id = $2",
            SYSTEM_CLASS_UUIDS['page'], graph_id
        )
        page_type_id = row['id'] if row else 1
        
        # Get classes property ID
        row = await conn.fetchrow(
            "SELECT id FROM property WHERE uuid = $1",
            SYSTEM_PROPERTY_UUIDS['classes']
        )
        types_property_id = row['id'] if row else 1
        
        now = datetime.now(timezone.utc)
        
        # Get or create asset class ID
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE name = 'asset' AND is_class = TRUE AND graph_id = $1",
            graph_id
        )
        if row:
            asset_type_id = row['id']
        else:
            # Create the asset class
            uuid = generate_uuid()
            asset_type_id = await conn.fetchval("""
                INSERT INTO node (graph_id, uuid, name, icon, is_class, is_asset, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, 'asset', NULL, TRUE, TRUE, $3, $3, $4, $4)
                RETURNING id
            """, graph_id, uuid, now, user_id)
            
            # Give it the 'class' class itself
            type_row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid = $1 AND graph_id = $2",
                SYSTEM_CLASS_UUIDS['class'], graph_id
            )
            if type_row:
                # Create node_property assignment first
                np_id = await conn.fetchval("""
                    INSERT INTO node_property (uuid, node_id, property_id, create_date, write_date, create_uid, write_uid)
                    VALUES ($1, $2, $3, $4, $4, $5, $5)
                    RETURNING id
                """, generate_uuid(), asset_type_id, types_property_id, now, user_id)
                
                # Add type value to property_value_relation (target_id instead of target_node_id)
                await conn.execute("""
                    INSERT INTO property_value_relation 
                        (uuid, node_property_id, property_id, node_id, target_id, create_date, write_date, create_uid, write_uid)
                    VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7)
                """, generate_uuid(), np_id, types_property_id, asset_type_id, type_row['id'], now, user_id)
    
    return page_type_id, types_property_id, asset_type_id


@router.post("/upload", response_model=AssetResponse)
async def upload_asset(
    file: UploadFile = File(...),
    parent_id: Optional[int] = None,
    existing_node_id: Optional[int] = None,
    current_user: User = Depends(get_current_user)
):
    """Upload a new asset file using AssetService.
    
    Creates a node with the 'asset' type and stores the file
    in the graph's assets folder using atomic operations.
    
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
    
    user_id = int(current_user.id)
    pool = await get_pool()
    
    async with pool.acquire() as conn:
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
    
    try:
        page_type_id, types_property_id, asset_type_id = await _get_system_ids(pool, graph_id, user_id)
        
        # Initialize AssetService
        asset_service = AssetService(graph_id)
        
        # Create asset using service (ATOMIC OPERATION)
        # This creates folder + writes file before we create node
        asset_uuid, extension = await asset_service.create_asset(
            file_bytes=content,
            original_filename=file.filename or f"asset{get_extension_from_content_type(content_type)}",
            content_type=content_type
        )
        
        # Extract filename without extension for node name
        filename_without_ext = Path(file.filename).stem if file.filename else "asset"
        
        # Create repository
        node_repo = PostgresNodeRepository(pool, graph_id, page_type_id, types_property_id, user_id)
        
        # If existing_node_id is provided, convert that node to an asset
        if existing_node_id:
            node = await node_repo.get(existing_node_id)
            if not node:
                raise HTTPException(status_code=404, detail=f"Node {existing_node_id} not found")
            
            # Update the node to be an asset
            async with pool.acquire() as conn:
                now = datetime.now(timezone.utc)
                await conn.execute("""
                    UPDATE node 
                    SET name = $1, uuid = $2, is_asset = TRUE, write_date = $3, write_uid = $4
                    WHERE id = $5 AND graph_id = $6
                """, filename_without_ext, asset_uuid, now, user_id, existing_node_id, graph_id)
                
                # Add asset class to the node
                if asset_type_id:
                    # Create node_property assignment
                    np_id = await conn.fetchval("""
                        INSERT INTO node_property (uuid, node_id, property_id, create_date, write_date, create_uid, write_uid)
                        VALUES ($1, $2, $3, $4, $4, $5, $5)
                        RETURNING id
                    """, generate_uuid(), existing_node_id, types_property_id, now, user_id)
                    
                    # Add class value
                    await conn.execute("""
                        INSERT INTO property_value_relation 
                            (uuid, node_property_id, property_id, node_id, target_id, create_date, write_date, create_uid, write_uid)
                        VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7)
                    """, generate_uuid(), np_id, types_property_id, existing_node_id, asset_type_id, now, user_id)
            
            # Fetch updated node
            node = await node_repo.get(existing_node_id)
            if not node:
                raise HTTPException(status_code=500, detail="Failed to update node to asset")
        else:
            # Create the asset node ONLY after file is safely written
            data = NodeCreateData(
                uuid=asset_uuid,  # Use UUID from service
                name=filename_without_ext,
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
            url=f"/api/assets/{node.uuid}"
        )
        
    except AssetPermissionError as e:
        logger.error(f"Permission error uploading asset: {e}")
        raise HTTPException(status_code=403, detail=str(e))
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
    
    Scans the per-asset folder: assets/{uuid}/{uuid}.{ext}
    """
    # Try token param first (for img/audio src), fall back to header auth
    user = await get_user_from_token_param(token) if token else None
    if not user:
        user = current_user
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    user_id = int(user.id)
    pool = await get_pool()
    
    async with pool.acquire() as conn:
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
    
    assets_dir = get_graph_assets_dir(graph_id)
    asset_folder = assets_dir / asset_uuid
    
    # Check if asset folder exists
    if not asset_folder.exists() or not asset_folder.is_dir():
        raise HTTPException(status_code=404, detail="Asset not found")
    
    # Find the asset file: {uuid}.{ext}
    for ext in ALLOWED_CONTENT_TYPES.values():
        asset_path = asset_folder / f"{asset_uuid}{ext}"
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
    
    raise HTTPException(status_code=404, detail="Asset file not found in folder")


@router.get("/{asset_uuid}/thumbnail")
async def get_asset_thumbnail(
    asset_uuid: str,
    token: Optional[str] = None,
    current_user: Optional[User] = Depends(get_current_user_optional)
):
    """
    Get thumbnail for an image asset.
    
    Returns 404 if thumbnail doesn't exist (client should fall back to original).
    """
    # Try token param first (for img src), fall back to header auth
    user = await get_user_from_token_param(token) if token else None
    if not user:
        user = current_user
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    user_id = int(user.id)
    pool = await get_pool()
    
    async with pool.acquire() as conn:
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
    
    asset_service = AssetService(graph_id)
    thumbnail_path = asset_service.get_thumbnail_path(asset_uuid)
    
    if not thumbnail_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    
    return FileResponse(
        thumbnail_path,
        media_type="image/webp",
        filename=f"{asset_uuid}_thumbnail.webp"
    )


@router.get("/{asset_uuid}/info", response_model=AssetResponse)
async def get_asset_info(
    asset_uuid: str,
    current_user: User = Depends(get_current_user)
):
    """Get metadata about an asset from per-asset folder."""
    user_id = int(current_user.id)
    pool = await get_pool()
    
    async with pool.acquire() as conn:
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
    
    page_type_id, types_property_id, _ = await _get_system_ids(pool, graph_id, user_id)
    node_repo = PostgresNodeRepository(pool, graph_id, page_type_id, types_property_id, user_id)
    
    node = await node_repo.get_by_uuid(asset_uuid)
    if not node:
        raise HTTPException(status_code=404, detail="Asset node not found")
    
    # Find the asset file in per-asset folder
    assets_dir = get_graph_assets_dir(graph_id)
    asset_folder = assets_dir / asset_uuid
    
    if not asset_folder.exists() or not asset_folder.is_dir():
        raise HTTPException(status_code=404, detail="Asset folder not found")
    
    for ext in ALLOWED_CONTENT_TYPES.values():
        asset_path = asset_folder / f"{asset_uuid}{ext}"
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
    
    raise HTTPException(status_code=404, detail="Asset file not found in folder")


@router.delete("/{asset_uuid}")
async def delete_asset(
    asset_uuid: str,
    current_user: User = Depends(get_current_user)
):
    """Delete an asset and its associated node using AssetService."""
    user_id = int(current_user.id)
    pool = await get_pool()
    
    async with pool.acquire() as conn:
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
    
    page_type_id, types_property_id, _ = await _get_system_ids(pool, graph_id, user_id)
    node_repo = PostgresNodeRepository(pool, graph_id, page_type_id, types_property_id, user_id)
    
    # Get the node
    node = await node_repo.get_by_uuid(asset_uuid)
    if not node:
        raise HTTPException(status_code=404, detail="Asset node not found")
    
    # Delete the node first (references must be cleaned up)
    if node.id:
        await node_repo.delete(node.id)
    
    # Then delete the asset folder (failures logged, not raised)
    asset_service = AssetService(graph_id)
    asset_service.delete_asset(asset_uuid)
    
    logger.info(f"Deleted asset {asset_uuid} for user {user_id}")
    
    return {"status": "deleted", "uuid": asset_uuid}


@router.get("/", response_model=AssetListResponse)
async def list_assets(
    page: int = 1,
    page_size: int = 50,
    current_user: User = Depends(get_current_user)
):
    """List all assets in the current workspace."""
    user_id = int(current_user.id)
    pool = await get_pool()
    
    async with pool.acquire() as conn:
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
    
    page_type_id, types_property_id, asset_type_id = await _get_system_ids(pool, graph_id, user_id)
    node_repo = PostgresNodeRepository(pool, graph_id, page_type_id, types_property_id, user_id)
    
    # Get nodes that have the 'asset' type
    if asset_type_id is None:
        return AssetListResponse(assets=[], total=0)
    nodes = await node_repo.get_typed_with(asset_type_id)
    
    # Apply pagination
    start = (page - 1) * page_size
    end = start + page_size
    paged_nodes = nodes[start:end]
    
    assets = []
    assets_dir = get_graph_assets_dir(graph_id)
    
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
