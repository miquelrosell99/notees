"""PostgreSQL implementation of User repository.

Updated for graph-based schema:
- is_active -> active
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import asyncpg

from ..entities import User, UserCreateData, generate_uuid
from .interfaces import UserRepository
from .base import normalize_timestamp
from ...utils import utc_now


class PostgresUserRepository(UserRepository):
    """PostgreSQL implementation of the UserRepository.
    
    Updated for new schema:
    - is_active -> active
    """
    
    def __init__(self, pool: asyncpg.Pool):
        """Initialize with connection pool."""
        self._pool = pool
    
    def _row_to_user(self, row: asyncpg.Record) -> User:
        """Convert database row to User entity."""
        create_date = row['create_date']
        write_date = row['write_date']
        
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
        
        return User(
            id=row['id'],
            uuid=str(row['uuid']),
            username=row['username'],
            password_hash=row['password_hash'],
            active=row['active'],  # Changed from is_active
            create_date=create_date,
            write_date=write_date,
        )
    
    async def create(self, data: UserCreateData, password_hash: str) -> User:
        """Create a new user."""
        now = utc_now()
        uuid = generate_uuid()
        
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO "user" (uuid, username, password_hash, active, create_date, write_date)
                VALUES ($1, $2, $3, TRUE, $4, $4)
                RETURNING *
            """, uuid, data.username, password_hash, now)
            
            if row is None:
                raise RuntimeError("Failed to create user - no row returned")
            return self._row_to_user(row)
    
    async def get_by_id(self, user_id: int) -> Optional[User]:
        """Get user by ID."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT * FROM "user" WHERE id = $1',
                user_id
            )
            return self._row_to_user(row) if row else None
    
    async def get_by_uuid(self, uuid: str) -> Optional[User]:
        """Get user by UUID."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT * FROM "user" WHERE uuid = $1',
                uuid
            )
            return self._row_to_user(row) if row else None
    
    async def get_by_username(self, username: str) -> Optional[User]:
        """Get user by username."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT * FROM "user" WHERE username = $1',
                username
            )
            return self._row_to_user(row) if row else None
    
    async def update_password(self, user_id: int, password_hash: str) -> bool:
        """Update user password."""
        now = utc_now()
        async with self._pool.acquire() as conn:
            result = await conn.execute("""
                UPDATE "user" 
                SET password_hash = $1, write_date = $2
                WHERE id = $3
            """, password_hash, now, user_id)
            return result == "UPDATE 1"
    
    async def deactivate(self, user_id: int) -> bool:
        """Deactivate a user (soft delete)."""
        now = utc_now()
        async with self._pool.acquire() as conn:
            result = await conn.execute("""
                UPDATE "user" 
                SET active = FALSE, write_date = $1
                WHERE id = $2
            """, now, user_id)
            return result == "UPDATE 1"
    
    async def get_password_hash(self, user_id: int) -> Optional[str]:
        """Get the password hash for a user."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT password_hash FROM "user" WHERE id = $1',
                user_id
            )
            return row['password_hash'] if row else None
