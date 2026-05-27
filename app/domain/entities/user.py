"""User domain entity."""

from __future__ import annotations

from dataclasses import dataclass, field

from . import generate_uuid, utc_now_iso


@dataclass
class User:
    """Domain entity representing a user."""

    username: str
    password_hash: str
    id: int | None = None
    uuid: str = field(default_factory=generate_uuid)
    active: bool = True  # soft-delete flag
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)

    def deactivate(self) -> None:
        """Deactivate the user account."""
        self.active = False
        self.write_date = utc_now_iso()


@dataclass
class UserCreateData:
    """Data for creating a new user."""

    username: str
    password: str  # Plain password, will be hashed


@dataclass
class UserCredentials:
    """User credentials for authentication."""

    username: str
    password: str


@dataclass
class AuthenticatedUser:
    """User with authentication context."""

    id: int
    uuid: str
    username: str
    is_active: bool
    token: str | None = None
