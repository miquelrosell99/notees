"""User repository re-exports.

This module re-exports the user repository interfaces and implementations
from the domain layer for backward compatibility.

The actual implementations are in app/domain/repositories/postgres_user.py.
"""
from app.domain.repositories.interfaces import UserRepository
from app.domain.repositories.postgres_user import PostgresUserRepository

__all__ = ["UserRepository", "PostgresUserRepository"]
