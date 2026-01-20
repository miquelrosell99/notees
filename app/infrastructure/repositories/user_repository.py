"""User repository interface and SQLite implementation.

This module defines the repository pattern for User persistence.
"""
from __future__ import annotations

from typing import Optional, List, Protocol, runtime_checkable
from datetime import datetime, timezone

from ...domain.entities.user import User, UserId


@runtime_checkable
class UserRepository(Protocol):
    """Abstract repository interface for User persistence."""
    
    async def get_by_id(self, user_id: UserId) -> Optional[User]:
        """Get a user by their ID."""
        ...
    
    async def get_by_username(self, username: str) -> Optional[User]:
        """Get a user by their username."""
        ...
    
    async def save(self, user: User, password_hash: str) -> User:
        """Persist a user with their password hash."""
        ...
    
    async def get_password_hash(self, user_id: UserId) -> Optional[str]:
        """Get the password hash for a user."""
        ...
    
    async def update_password(self, user_id: UserId, password_hash: str) -> bool:
        """Update a user's password hash."""
        ...


class SQLiteUserRepository:
    """SQLite implementation of UserRepository.
    
    Note: This is a placeholder implementation.
    The actual user storage currently uses JSON files.
    This would need to be updated if we move to SQLite for users.
    """
    
    def __init__(self, db_connection):
        """Initialize with a database connection."""
        self._conn = db_connection
    
    async def get_by_id(self, user_id: UserId) -> Optional[User]:
        """Get a user by their ID."""
        cursor = await self._conn.execute(
            "SELECT * FROM users WHERE id = ?",
            (user_id,)
        )
        row = await cursor.fetchone()
        
        if not row:
            return None
        
        return self._row_to_user(row)
    
    async def get_by_username(self, username: str) -> Optional[User]:
        """Get a user by their username."""
        cursor = await self._conn.execute(
            "SELECT * FROM users WHERE username = ?",
            (username,)
        )
        row = await cursor.fetchone()
        
        if not row:
            return None
        
        return self._row_to_user(row)
    
    async def save(self, user: User, password_hash: str) -> User:
        """Persist a user with their password hash."""
        existing = await self.get_by_id(user.id)
        
        if existing:
            await self._conn.execute(
                """
                UPDATE users SET 
                    username = ?, is_active = ?, updated_at = ?
                WHERE id = ?
                """,
                (user.username, user.is_active, datetime.now(timezone.utc).isoformat(), user.id)
            )
        else:
            await self._conn.execute(
                """
                INSERT INTO users (id, username, password_hash, is_active, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (user.id, user.username, password_hash, user.is_active, 
                 user.created_at.isoformat() if user.created_at else datetime.now(timezone.utc).isoformat())
            )
        
        await self._conn.commit()
        return user
    
    async def get_password_hash(self, user_id: UserId) -> Optional[str]:
        """Get the password hash for a user."""
        cursor = await self._conn.execute(
            "SELECT password_hash FROM users WHERE id = ?",
            (user_id,)
        )
        row = await cursor.fetchone()
        
        return row[0] if row else None
    
    async def update_password(self, user_id: UserId, password_hash: str) -> bool:
        """Update a user's password hash."""
        cursor = await self._conn.execute(
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (password_hash, datetime.now(timezone.utc).isoformat(), user_id)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    def _row_to_user(self, row) -> User:
        """Convert a database row to a User entity."""
        return User(
            id=row["id"],
            username=row["username"],
            created_at=datetime.fromisoformat(row["created_at"]) if row["created_at"] else datetime.now(timezone.utc),
            is_active=bool(row["is_active"]) if "is_active" in row.keys() else True,
        )
