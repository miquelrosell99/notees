"""FastAPI dependencies for the assets feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg
import jwt
from fastapi import Depends, HTTPException, Query, Request

from app.config import settings
from app.db.connection import get_pool, get_workspace_uuid
from app.dependencies import (
    _get_workspace_context_cached,
    get_current_user,
    get_current_user_optional,
    get_node_repository,
)
from app.features.assets.port import AssetRepository
from app.features.assets.repository import PostgresAssetRepository
from app.features.assets.service import AssetService
from app.features.nodes.dependencies import _make_node_repository
from app.features.nodes.port import NodeRepository
from app.logging_config import get_logger
from app.models import User

logger = get_logger(__name__)
_ASSET_TOKEN_LEEWAY_SECONDS = 60


def _make_asset_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> AssetRepository:
    return PostgresAssetRepository(pool, workspace_id, user_id)


async def get_asset_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[AssetRepository, None]:
    """Get an AssetRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_asset_repository(pool, workspace_id, user_id)


def _decode_asset_token(token: str) -> dict | None:
    """Decode and verify an asset token.

    Allows a small leeway for clock skew between the client and server.
    """
    try:
        payload = jwt.decode(
            token,
            settings.secret_key,
            algorithms=[settings.algorithm],
            leeway=_ASSET_TOKEN_LEEWAY_SECONDS,
        )
        if payload.get("type") != "asset_access":
            logger.warning("Asset token rejected: wrong type")
            return None
        return payload
    except jwt.ExpiredSignatureError as e:
        logger.warning(f"Asset token expired: {e}")
        return None
    except jwt.InvalidTokenError as e:
        logger.warning(f"Asset token invalid: {e}")
        return None
    except Exception as e:
        logger.warning(f"Asset token decode error: {e}")
        return None


async def _get_user_from_asset_token(asset_token: str, asset_uuid: str) -> User | None:
    """Get user from asset token and validate it matches the requested asset."""
    from app.features.auth import get_user_by_id

    payload = _decode_asset_token(asset_token)
    if not payload:
        return None
    if payload.get("asset_uuid") != asset_uuid:
        logger.warning(f"Asset token asset_uuid mismatch: {payload.get('asset_uuid')} != {asset_uuid}")
        return None
    user_id = payload.get("user_id")
    if not user_id:
        logger.warning(f"Asset token missing user_id for asset {asset_uuid}")
        return None
    user_data = await get_user_by_id(user_id)
    if not user_data:
        logger.warning(f"Asset token user not found: user_id={user_id}, asset={asset_uuid}")
        return None
    return User(**user_data)


async def get_asset_service(
    user: User = Depends(get_current_user),
    asset_repo: AssetRepository = Depends(get_asset_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
) -> AsyncGenerator[AssetService, None]:
    """Get an AssetService wired to the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        raise HTTPException(status_code=500, detail="Workspace UUID not found")
    yield AssetService(workspace_uuid, user_id, node_repo, asset_repo)


async def get_asset_service_with_token(
    request: Request,
    asset_token: str | None = Query(None, description="Short-lived asset access token"),
    current_user: User | None = Depends(get_current_user_optional),
) -> AsyncGenerator[AssetService, None]:
    """Build an AssetService for the user resolved from JWT/API key or asset_token."""
    user = current_user
    path_asset_uuid = request.path_params.get("asset_uuid")

    if not user and asset_token:
        if path_asset_uuid:
            user = await _get_user_from_asset_token(asset_token, path_asset_uuid)
            if not user:
                logger.warning(
                    f"Asset auth failed for {path_asset_uuid}: token present but user not resolved"
                )
                raise HTTPException(status_code=401, detail="Invalid or expired asset token")
        else:
            logger.warning("Asset auth failed: asset_token present but no asset_uuid in path")
            raise HTTPException(status_code=401, detail="Invalid or expired asset token")

    if not user:
        logger.warning(f"Asset auth failed for {path_asset_uuid}: no asset_token or current_user")
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
