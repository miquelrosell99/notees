"""Admin router.

System-level admin endpoints for user management and metrics.
"""
from fastapi import APIRouter, Depends, HTTPException
from slowapi import Limiter
from slowapi.util import get_remote_address

from .. import auth
from ..db.connection import get_connection
from ..logging_config import get_logger
from ..models import AdminUserCreate, AdminUserUpdate
from .auth import require_admin

logger = get_logger(__name__)
router = APIRouter(prefix="/api/admin", tags=["Admin"])
limiter = Limiter(key_func=get_remote_address)


@router.get("/users")
async def list_users(admin_user=Depends(require_admin)):  # noqa: B008
    """List all users."""
    async with get_connection() as conn:
        rows = await conn.fetch(
            '''
            SELECT id, uuid, email, name, surnames, profile_pic, role, active, create_date
            FROM "user"
            ORDER BY create_date DESC
            '''
        )
    return {
        "users": [
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
    }


@router.post("/users")
async def create_user(
    data: AdminUserCreate,
    admin_user=Depends(require_admin),  # noqa: B008
):
    """Create a new user (admin only)."""
    user = await auth.create_user(
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
):
    """Update a user (admin only)."""
    async with get_connection() as conn:
        # Prevent removing admin role from yourself
        current = await conn.fetchrow(
            'SELECT role FROM "user" WHERE id::text = $1',
            user_id,
        )
        if not current:
            raise HTTPException(status_code=404, detail="User not found")

        if str(user_id) == str(admin_user.id) and data.role is not None and data.role != 'admin':
            raise HTTPException(status_code=400, detail="Cannot demote yourself")

        # Build dynamic SET clause for provided fields only
        updates: dict[str, object] = {}
        if data.email is not None:
            updates['email'] = data.email
        if data.name is not None:
            updates['name'] = data.name
        if data.surnames is not None:
            updates['surnames'] = data.surnames
        if data.profile_pic is not None:
            updates['profile_pic'] = data.profile_pic
        if data.role is not None:
            updates['role'] = data.role
        if data.active is not None:
            updates['active'] = data.active

        if not updates:
            row = await conn.fetchrow(
                '''
                SELECT id, uuid, email, name, surnames, profile_pic, role, active, create_date
                FROM "user" WHERE id::text = $1
                ''',
                user_id,
            )
        else:
            set_clauses = ', '.join(f'{k} = ${i + 1}' for i, k in enumerate(updates.keys()))
            values = list(updates.values())
            row = await conn.fetchrow(
                f'''
                UPDATE "user"
                SET {set_clauses}, write_date = NOW()
                WHERE id::text = ${len(values) + 1}
                RETURNING id, uuid, email, name, surnames, profile_pic, role, active, create_date
                ''',
                *values, user_id,
            )

        if not row:
            raise HTTPException(status_code=404, detail="User not found")

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
):
    """Deactivate a user (admin only)."""
    if str(user_id) == str(admin_user.id):
        raise HTTPException(status_code=400, detail="Cannot deactivate yourself")

    async with get_connection() as conn:
        result = await conn.execute(
            'UPDATE "user" SET active = FALSE WHERE id::text = $1',
            user_id,
        )
        if result.split()[-1] == "0":
            raise HTTPException(status_code=404, detail="User not found")

    return {"success": True}


@router.get("/metrics")
async def get_metrics(admin_user=Depends(require_admin)):  # noqa: B008
    """Get system metrics."""
    async with get_connection() as conn:
        node_count = await conn.fetchval("SELECT COUNT(*) FROM node WHERE active = TRUE")
        page_count = await conn.fetchval(
            "SELECT COUNT(*) FROM node WHERE active = TRUE AND is_page = TRUE"
        )
        block_count = await conn.fetchval(
            "SELECT COUNT(*) FROM node WHERE active = TRUE AND is_page = FALSE"
        )
        daily_count = await conn.fetchval(
            "SELECT COUNT(*) FROM node WHERE active = TRUE AND is_day = TRUE"
        )
        user_count = await conn.fetchval('SELECT COUNT(*) FROM "user"')
        workspace_count = await conn.fetchval("SELECT COUNT(*) FROM workspace WHERE active = TRUE")
        public_share_count = await conn.fetchval(
            "SELECT COUNT(*) FROM node_public_share WHERE active = TRUE"
        )
        user_share_count = await conn.fetchval(
            "SELECT COUNT(*) FROM node_share WHERE active = TRUE"
        )

    import shutil

    from ..config import settings
    storage_used = 0
    if settings.data_dir.exists():
        storage_used = shutil.disk_usage(settings.data_dir).used

    return {
        "nodes": {
            "total": node_count,
            "pages": page_count,
            "blocks": block_count,
            "daily_journals": daily_count,
        },
        "users": user_count,
        "workspaces": workspace_count,
        "shares": {
            "public": public_share_count,
            "user": user_share_count,
        },
        "storage_bytes": storage_used,
    }
