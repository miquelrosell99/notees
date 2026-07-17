"""Asyncpg connection helper for the migration script.

Reads PostgreSQL connection parameters from environment variables, falling back
to the defaults used by the Notees development stack.
"""

from __future__ import annotations

import os
from typing import Any

import asyncpg
from dotenv import load_dotenv

DEFAULTS: dict[str, Any] = {
    "host": "localhost",
    "port": 5433,
    "user": "notees",
    "password": "",
    "database": "notees",
}


def _load_env() -> None:
    """Load environment variables from ``.env`` when present."""
    load_dotenv()


def postgres_dsn_from_env() -> dict[str, Any]:
    """Return a connection kwargs dict from environment variables.

    Variables read:
      - POSTGRES_HOST (default: localhost)
      - POSTGRES_PORT (default: 5433)
      - POSTGRES_USER (default: notees)
      - POSTGRES_PASSWORD (default: empty string)
      - POSTGRES_DB (default: notees)
    """
    _load_env()
    return {
        "host": os.getenv("POSTGRES_HOST", DEFAULTS["host"]),
        "port": int(os.getenv("POSTGRES_PORT", str(DEFAULTS["port"]))),
        "user": os.getenv("POSTGRES_USER", DEFAULTS["user"]),
        "password": os.getenv("POSTGRES_PASSWORD", DEFAULTS["password"]),
        "database": os.getenv("POSTGRES_DB", DEFAULTS["database"]),
    }


async def connect_postgres(**overrides: Any) -> asyncpg.Connection:
    """Connect to PostgreSQL using environment-driven defaults.

    Any keyword argument overrides the value read from the environment.
    """
    config = postgres_dsn_from_env()
    config.update(overrides)
    return await asyncpg.connect(**config)
