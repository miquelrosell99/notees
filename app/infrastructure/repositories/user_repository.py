"""User repository re-exports.

This module re-exports the user repository interfaces and implementations
from the domain layer for backward compatibility.

The actual implementations are in app/domain/repositories/postgres_user.py.
"""
from app.domain.repositories.interfaces import UserRepository
from app.domain.repositories.postgres_user import PostgresUserRepository

__all__ = ["UserRepository", "PostgresUserRepository"]
    
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
