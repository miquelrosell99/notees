"""Assets router - handles file uploads and downloads.

Assets are stored as files in the database's assets folder:
  databases/{db_name}/assets/{node_uuid}.{extension}

Each asset is associated with a node that has the 'asset' type tag.
Supported file types: Images (JPEG, PNG), Audio (MP3, WAV, OGG, OPUS, WebM)
"""
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, List
from pathlib import Path
import uuid as uuid_module

from ..db.connection import get_assets_dir, get_active_db_name, get_db
from ..domain.entities import NodeCreateData
from ..domain.repositories import SQLiteNodeRepository, SQLiteLinkRepository, SQLitePropertyRepository
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


def get_asset_path(user_id: str, asset_uuid: str, extension: str, db_name: Optional[str] = None) -> Path:
    """Get the file path for an asset."""
    assets_dir = get_assets_dir(user_id, db_name)
    return assets_dir / f"{asset_uuid}{extension}"


def get_extension_from_content_type(content_type: str) -> str:
    """Get file extension from content type."""
    return ALLOWED_CONTENT_TYPES.get(content_type, "")


async def _get_system_ids(user_id: str):
    """Get system type IDs from the database."""
    db = await get_db(user_id)
    try:
        # Get page type ID
        cursor = await db.execute(
            "SELECT id FROM node WHERE name = 'page' AND is_type = 1 LIMIT 1"
        )
        row = await cursor.fetchone()
        page_type_id = row['id'] if row else 1
        
        # Get types property ID
        cursor = await db.execute(
            "SELECT id FROM property WHERE name = 'types' LIMIT 1"
        )
        row = await cursor.fetchone()
        types_property_id = row['id'] if row else 1
        
        # Get or create asset type ID
        cursor = await db.execute(
            "SELECT id FROM node WHERE name = 'asset' AND is_type = 1 LIMIT 1"
        )
        row = await cursor.fetchone()
        if row:
            asset_type_id = row['id']
        else:
            # Create the asset type
            now = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
            uuid = str(uuid_module.uuid4())
            cursor = await db.execute("""
                INSERT INTO node (uuid, name, icon, is_type, is_asset, create_date, write_date)
                VALUES (?, 'asset', NULL, 1, 1, ?, ?)
            """, (uuid, now, now))
            asset_type_id = cursor.lastrowid
            
            # Give it the 'type' type itself
            cursor = await db.execute(
                "SELECT id FROM node WHERE name = 'type' AND is_type = 1 LIMIT 1"
            )
            type_row = await cursor.fetchone()
            if type_row:
                # Create node_property assignment first
                await db.execute("""
                    INSERT INTO node_property (node_id, property_id, create_date, write_date)
                    VALUES (?, ?, ?, ?)
                """, (asset_type_id, types_property_id, now, now))
                
                # Get node_property id
                cursor = await db.execute(
                    "SELECT id FROM node_property WHERE node_id = ? AND property_id = ?",
                    (asset_type_id, types_property_id)
                )
                np_row = await cursor.fetchone()
                
                # Add type value to property_value_relation
                await db.execute("""
                    INSERT INTO property_value_relation 
                        (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
                    VALUES (?, ?, ?, ?, 0, ?, ?)
                """, (np_row['id'], types_property_id, asset_type_id, type_row['id'], now, now))
            
            await db.commit()
        
        return db, page_type_id, types_property_id, asset_type_id
    except Exception:
        await db.close()
        raise


@router.post("/upload", response_model=AssetResponse)
async def upload_asset(
    file: UploadFile = File(...),
    parent_id: Optional[int] = None,
    current_user: User = Depends(get_current_user)
):
    """Upload a new asset file.
    
    Creates a node with the 'asset' type and stores the file
    in the database's assets folder.
    
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
    db_name = get_active_db_name(user_id)
    
    db = None
    try:
        db, page_type_id, types_property_id, asset_type_id = await _get_system_ids(user_id)
        
        # Get file extension and category
        extension = get_extension_from_content_type(content_type)
        category = get_asset_category(content_type)
        
        # Create repositories
        node_repo = SQLiteNodeRepository(db, page_type_id, types_property_id)
        
        # Create the asset node with 'asset' type
        data = NodeCreateData(
            name=file.filename or f"asset{extension}",
            parent_id=parent_id,
            types=[asset_type_id] if asset_type_id else [],
            is_asset=True,
        )
        
        node = await node_repo.create(data)
        
        # Save file to assets directory using node UUID
        asset_path = get_asset_path(user_id, node.uuid, extension, db_name)
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
    finally:
        if db:
            await db.close()


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
    db_name = get_active_db_name(user_id)
    assets_dir = get_assets_dir(user_id, db_name)
    
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
    db_name = get_active_db_name(user_id)
    
    db = None
    try:
        db, page_type_id, types_property_id, _ = await _get_system_ids(user_id)
        node_repo = SQLiteNodeRepository(db, page_type_id, types_property_id)
        
        node = await node_repo.get_by_uuid(asset_uuid)
        if not node:
            raise HTTPException(status_code=404, detail="Asset node not found")
        
        # Find the asset file
        assets_dir = get_assets_dir(user_id, db_name)
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
        
    finally:
        if db:
            await db.close()


@router.delete("/{asset_uuid}")
async def delete_asset(
    asset_uuid: str,
    current_user: User = Depends(get_current_user)
):
    """Delete an asset and its associated node."""
    user_id = current_user.id
    db_name = get_active_db_name(user_id)
    
    db = None
    try:
        db, page_type_id, types_property_id, _ = await _get_system_ids(user_id)
        node_repo = SQLiteNodeRepository(db, page_type_id, types_property_id)
        
        node = await node_repo.get_by_uuid(asset_uuid)
        if not node:
            raise HTTPException(status_code=404, detail="Asset node not found")
        
        # Delete the file first
        assets_dir = get_assets_dir(user_id, db_name)
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
        
    finally:
        if db:
            await db.close()


@router.get("/", response_model=AssetListResponse)
async def list_assets(
    page: int = 1,
    page_size: int = 50,
    current_user: User = Depends(get_current_user)
):
    """List all assets in the current database."""
    user_id = current_user.id
    db_name = get_active_db_name(user_id)
    
    db = None
    try:
        db, page_type_id, types_property_id, asset_type_id = await _get_system_ids(user_id)
        node_repo = SQLiteNodeRepository(db, page_type_id, types_property_id)
        
        # Get nodes that have the 'asset' type
        if asset_type_id is None:
            return AssetListResponse(assets=[], total=0)
        nodes = await node_repo.get_typed_with(asset_type_id)
        
        # Apply pagination
        start = (page - 1) * page_size
        end = start + page_size
        paged_nodes = nodes[start:end]
        
        assets = []
        assets_dir = get_assets_dir(user_id, db_name)
        
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
        
    finally:
        if db:
            await db.close()
