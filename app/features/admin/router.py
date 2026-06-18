"""Admin router.

System-level admin endpoints for user management and metrics.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.features.auth import auth as auth_module
from app.features.auth import hash_password
from app.features.auth.dependencies import get_user_repository
from app.features.auth.port import UserRepository
from app.features.auth.router import require_admin
from app.logging_config import get_logger
from app.models import AdminUserCreate, AdminUserUpdate, PaginatedResponse
from app.system_settings import get_all_system_settings, get_system_setting, set_system_setting

logger = get_logger(__name__)
router = APIRouter(prefix="/admin", tags=["Admin"])


class SystemSettingUpdate(BaseModel):
    """Request body for updating a system setting."""

    value: Any


@router.get("/users")
async def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    admin_user=Depends(require_admin),  # noqa: B008
    user_repo: UserRepository = Depends(get_user_repository),
):
    """List all users."""
    total, rows = await user_repo.list_users_paginated(page, page_size)

    items = [
        {
            "id": str(r["id"]),
            "uuid": str(r["uuid"]),
            "email": r["email"],
            "name": r["name"],
            "surnames": r["surnames"],
            "profile_pic": r["profile_pic"],
            "role": r["role"],
            "active": r["active"],
            "created_at": r["create_date"].isoformat() if r["create_date"] else None,
        }
        for r in rows
    ]
    return PaginatedResponse[dict](
        items=items,
        total=total or 0,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < (total or 0),
        has_prev=page > 1,
    )


@router.post("/users")
async def create_user(
    data: AdminUserCreate,
    admin_user=Depends(require_admin),  # noqa: B008
):
    """Create a new user (admin only)."""
    user = await auth_module.create_user(
        email=data.email,
        password=data.password,
        name=data.name,
        surnames=data.surnames,
        profile_pic=data.profile_pic,
        role=data.role,
    )
    return user


@router.put("/users/{user_id}")
async def update_user(
    user_id: str,
    data: AdminUserUpdate,
    admin_user=Depends(require_admin),  # noqa: B008
    user_repo: UserRepository = Depends(get_user_repository),
):
    """Update a user (admin only)."""
    current = await user_repo.get_by_id_or_uuid(user_id)
    if not current:
        raise HTTPException(status_code=404, detail="User not found")

    if str(user_id) == str(admin_user.id) and data.role is not None and data.role != "admin":
        raise HTTPException(status_code=400, detail="Cannot demote yourself")

    # Prevent demoting the last active admin
    if data.role is not None and current.role == "admin" and data.role != "admin":
        other_admins = await user_repo.count_other_admins(int(user_id))
        if other_admins == 0:
            raise HTTPException(status_code=400, detail="Cannot demote the last admin")

    # Build dynamic SET clause for provided fields only
    updates: dict[str, object] = {}
    if data.email is not None:
        updates["email"] = data.email
    if data.password is not None:
        updates["password_hash"] = hash_password(data.password)
    if data.name is not None:
        updates["name"] = data.name
    if data.surnames is not None:
        updates["surnames"] = data.surnames
    if data.profile_pic is not None:
        updates["profile_pic"] = data.profile_pic
    if data.role is not None:
        updates["role"] = data.role
    if data.active is not None:
        updates["active"] = data.active

    row = await user_repo.update_user_admin(user_id, updates)

    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    if data.password is not None:
        user_id_int = int(user_id)
        await auth_module.revoke_all_user_refresh_tokens(user_id_int)
        await auth_module.revoke_all_user_api_keys(user_id_int)
        auth_module.clear_user_cache(user_id)

    return {
        "id": str(row["id"]),
        "uuid": str(row["uuid"]),
        "email": row["email"],
        "name": row["name"],
        "surnames": row["surnames"],
        "profile_pic": row["profile_pic"],
        "role": row["role"],
        "active": row["active"],
        "created_at": row["create_date"].isoformat() if row["create_date"] else None,
    }


@router.delete("/users/{user_id}")
async def deactivate_user(
    user_id: str,
    admin_user=Depends(require_admin),  # noqa: B008
    user_repo: UserRepository = Depends(get_user_repository),
):
    """Deactivate a user (admin only)."""
    if str(user_id) == str(admin_user.id):
        raise HTTPException(status_code=400, detail="Cannot deactivate yourself")

    target = await user_repo.get_by_id_or_uuid(user_id)
    if not target or not target.active:
        raise HTTPException(status_code=404, detail="User not found")

    # Prevent deactivating the last active admin
    if target.role == "admin":
        other_admins = await user_repo.count_other_admins(int(user_id))
        if other_admins == 0:
            raise HTTPException(status_code=400, detail="Cannot deactivate the last admin")

    await user_repo.deactivate_user_admin(user_id)

    return {"success": True}


@router.get("/metrics")
async def get_metrics(
    admin_user=Depends(require_admin),  # noqa: B008
    user_repo: UserRepository = Depends(get_user_repository),
):
    """Get system metrics."""
    return await user_repo.get_system_metrics()


@router.get("/settings")
async def list_system_settings(admin_user=Depends(require_admin)):  # noqa: B008
    """Get all system settings."""
    settings_dict = await get_all_system_settings()
    return {"settings": settings_dict}


@router.get("/settings/{key}")
async def get_system_setting_endpoint(
    key: str,
    admin_user=Depends(require_admin),  # noqa: B008
):
    """Get a single system setting."""
    value = await get_system_setting(key)
    if value is None:
        raise HTTPException(status_code=404, detail=f"Setting '{key}' not found")
    return {"key": key, "value": value}


@router.put("/settings/{key}")
async def update_system_setting(
    key: str,
    data: SystemSettingUpdate,
    admin_user=Depends(require_admin),  # noqa: B008
):
    """Update a system setting."""
    value = data.value
    if value is None:
        raise HTTPException(status_code=400, detail="Missing 'value' field")
    await set_system_setting(key, value)
    return {"key": key, "value": value}


@router.post("/assets/audit")
async def audit_assets(
    dry_run: bool = True,
    admin_user=Depends(require_admin),  # noqa: B008
    user_repo: UserRepository = Depends(get_user_repository),
):
    """Audit asset files on disk vs. active asset nodes in the database.

    Scans all workspace asset directories and reports (or deletes) orphaned files
    that have no corresponding active node row.
    """
    return await user_repo.audit_assets(dry_run)
