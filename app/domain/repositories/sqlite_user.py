"""SQLite implementation of User repository."""
from __future__ import annotations

from typing import Optional

import aiosqlite

from ..entities import User, UserCreateData, generate_uuid, utc_now_iso
from .interfaces import UserRepository


class SQLiteUserRepository(UserRepository):
    """SQLite implementation of the UserRepository."""
    
    def __init__(self, connection: aiosqlite.Connection):
        """Initialize with database connection."""
        self._conn = connection
    
    def _row_to_user(self, row: aiosqlite.Row) -> User:
        """Convert database row to User entity."""
        return User(
            id=row['id'],
            uuid=row['uuid'],
            username=row['username'],
            password_hash=row['password_hash'],
            is_active=bool(row['is_active']),
            create_date=row['create_date'],
            write_date=row['write_date'],
        )
    
    async def create(self, data: UserCreateData, password_hash: str) -> User:
        """Create a new user."""
        now = utc_now_iso()
        uuid = generate_uuid()
        
        cursor = await self._conn.execute("""
            INSERT INTO user (uuid, username, password_hash, is_active, create_date, write_date)
            VALUES (?, ?, ?, 1, ?, ?)
        """, (uuid, data.username, password_hash, now, now))
        
        await self._conn.commit()
        
        return User(
            id=cursor.lastrowid,
            uuid=uuid,
            username=data.username,
            password_hash=password_hash,
            is_active=True,
            create_date=now,
            write_date=now,
        )
    
    async def get_by_id(self, user_id: int) -> Optional[User]:
        """Get user by ID."""
        cursor = await self._conn.execute(
            "SELECT * FROM user WHERE id = ?",
            (user_id,)
        )
        row = await cursor.fetchone()
        return self._row_to_user(row) if row else None
    
    async def get_by_uuid(self, uuid: str) -> Optional[User]:
        """Get user by UUID."""
        cursor = await self._conn.execute(
            "SELECT * FROM user WHERE uuid = ?",
            (uuid,)
        )
        row = await cursor.fetchone()
        return self._row_to_user(row) if row else None
    
    async def get_by_username(self, username: str) -> Optional[User]:
        """Get user by username."""
        cursor = await self._conn.execute(
            "SELECT * FROM user WHERE username = ?",
            (username,)
        )
        row = await cursor.fetchone()
        return self._row_to_user(row) if row else None
    
    async def update_password(self, user_id: int, password_hash: str) -> bool:
        """Update user password."""
        now = utc_now_iso()
        cursor = await self._conn.execute(
            "UPDATE user SET password_hash = ?, write_date = ? WHERE id = ?",
            (password_hash, now, user_id)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    async def deactivate(self, user_id: int) -> bool:
        """Deactivate a user."""
        now = utc_now_iso()
        cursor = await self._conn.execute(
            "UPDATE user SET is_active = 0, write_date = ? WHERE id = ?",
            (now, user_id)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
