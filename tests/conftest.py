"""Pytest configuration and fixtures for Notees tests.

This module provides shared fixtures for testing the Notees application.
"""
import asyncio
import os
import sys
import tempfile
import secrets
from pathlib import Path
from typing import AsyncGenerator, Generator

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.main import app
from app.config import settings


# ==================== PYTEST CONFIGURATION ====================

# Configure pytest-asyncio mode
pytest_plugins = ('pytest_asyncio',)


# ==================== DATABASE FIXTURES ====================

@pytest.fixture(scope="function")
def temp_data_dir(tmp_path: Path) -> Generator[Path, None, None]:
    """Create a temporary data directory for tests."""
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "users").mkdir(exist_ok=True)
    
    # Override settings
    original_dir = settings.database_dir
    settings.database_dir = data_dir
    
    # Also update the auth module's USERS_DIR
    from app import auth
    original_users_dir = auth.USERS_DIR
    auth.USERS_DIR = data_dir / "users"
    
    # Update database module's DATA_DIR (main module)
    from app import database
    original_db_data_dir = database.DATA_DIR
    database.DATA_DIR = data_dir
    
    # Update db/connection module's DATA_DIR
    from app.db import connection
    original_conn_data_dir = connection.DATA_DIR
    connection.DATA_DIR = data_dir
    
    yield data_dir
    
    # Restore
    settings.database_dir = original_dir
    auth.USERS_DIR = original_users_dir
    database.DATA_DIR = original_db_data_dir
    connection.DATA_DIR = original_conn_data_dir


@pytest_asyncio.fixture(scope="function")
async def test_user(temp_data_dir: Path) -> dict:
    """Create a test user and return user data with auth token."""
    from app import auth
    from app import database as db
    
    # Use unique username per test to avoid conflicts
    unique_id = secrets.token_hex(4)
    username = f"testuser_{unique_id}"
    
    user = await auth.create_user(username, "testpassword123")
    
    # Initialize database for user (this creates the nodes table)
    await db.init_db(user["id"], "default")
    db.set_active_db(user["id"], "default")
    
    token = auth.create_token(user["id"], user["username"])
    
    return {
        "id": user["id"],
        "username": user["username"],
        "token": token,
        "auth_header": {"Authorization": f"Bearer {token}"}
    }


# ==================== HTTP CLIENT FIXTURES ====================

@pytest_asyncio.fixture(scope="function")
async def client() -> AsyncGenerator[AsyncClient, None]:
    """Create an async HTTP client for testing."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture(scope="function")
async def authenticated_client(
    client: AsyncClient, 
    test_user: dict
) -> AsyncClient:
    """Create an authenticated HTTP client."""
    client.headers.update(test_user["auth_header"])
    return client


# Alias for integration tests
@pytest_asyncio.fixture(scope="function")
async def auth_client(authenticated_client: AsyncClient) -> AsyncClient:
    """Alias for authenticated_client for integration tests."""
    return authenticated_client


# ==================== NODE FIXTURES ====================

@pytest.fixture
def sample_node_data() -> dict:
    """Return sample node data for testing."""
    return {
        "name": "Test Page",
        "is_page": True,
        "tags": [],
        "properties": {},
    }


@pytest.fixture
def sample_block_data() -> dict:
    """Return sample block data for testing."""
    return {
        "name": "Test block content",
        "is_page": False,
        "tags": [],
        "properties": {},
    }


@pytest.fixture
def sample_daily_page_data() -> dict:
    """Return sample daily page data for testing."""
    return {
        "name": "2026-01-15",
        "is_page": True,
        "is_daily": True,
        "daily_date": "2026-01-15",
        "tags": [],
        "properties": {},
    }


# ==================== SYNC FIXTURES ====================

@pytest.fixture
def sample_sync_request() -> dict:
    """Return sample sync request data."""
    return {
        "last_sync": None,
        "nodes": [],
        "deleted_nodes": []
    }
