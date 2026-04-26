"""Pytest configuration and fixtures for Notees tests.

This module provides shared fixtures for testing the Notees application
using PostgreSQL. Supports two modes:

1. **Testcontainers (default)**: Spins up a PostgreSQL container per session
   - Requires Docker running
   - Fully isolated test database

2. **External database**: Uses an existing PostgreSQL instance
   - Set TEST_DATABASE_URL environment variable
   - Useful for CI/CD or when Docker isn't available
   - Database is cleaned between tests
"""
import asyncio
import os
import sys
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

pytest_plugins = ('pytest_asyncio',)


# ==================== DATABASE FIXTURES ====================

# Check for external database URL
_EXTERNAL_DB_URL = os.environ.get("TEST_DATABASE_URL")

# Flag to track if testcontainers import succeeded
_USE_TESTCONTAINERS = False
_PostgresContainer = None

if not _EXTERNAL_DB_URL:
    try:
        from testcontainers.postgres import PostgresContainer as _PostgresContainer
        _USE_TESTCONTAINERS = True
    except ImportError:
        pass


@pytest.fixture(scope="session")
def postgres_container():
    """Start a PostgreSQL container for the entire test session.
    
    This fixture uses testcontainers to spin up a real PostgreSQL instance.
    The container is started once per session and shared across all tests.
    
    If TEST_DATABASE_URL is set, this fixture is skipped and the external
    database is used instead.
    """
    if _EXTERNAL_DB_URL:
        # No container needed - using external database
        yield None
        return
        
    if not _USE_TESTCONTAINERS:
        pytest.skip(
            "Docker not available and TEST_DATABASE_URL not set. "
            "Either start Docker or set TEST_DATABASE_URL=postgresql://user:pass@host:port/dbname"
        )
        
    with _PostgresContainer(
        image="postgres:16-alpine",
        username="test",
        password="test",
        dbname="notees_test",
    ) as postgres:
        yield postgres


@pytest.fixture(scope="session")
def database_url(postgres_container) -> str:
    """Get the database URL for the test PostgreSQL instance."""
    if _EXTERNAL_DB_URL:
        return _EXTERNAL_DB_URL
        
    return postgres_container.get_connection_url().replace(
        "postgresql+psycopg2://", "postgresql://"
    )


@pytest.fixture(scope="function")
def temp_data_dir(tmp_path: Path) -> Generator[Path, None, None]:
    """Create a temporary data directory for user files (not database)."""
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "users").mkdir(exist_ok=True)
    
    # Override settings
    original_dir = settings.database_dir
    settings.database_dir = data_dir
    
    # Update auth module's USERS_DIR for user files (if it exists)
    from app import auth
    original_users_dir = getattr(auth, 'USERS_DIR', None)
    if original_users_dir is not None:
        auth.USERS_DIR = data_dir / "users"
    
    yield data_dir
    
    # Restore
    settings.database_dir = original_dir
    if original_users_dir is not None:
        auth.USERS_DIR = original_users_dir


@pytest_asyncio.fixture(scope="function")
async def db_pool(database_url: str, temp_data_dir: Path):
    """Initialize the PostgreSQL connection pool and schema for each test.
    
    This creates a fresh schema for each test by:
    1. Dropping all tables
    2. Re-running schema initialization
    """
    import asyncpg
    from app.db import connection, schema
    
    # Set the DATABASE_URL for the connection module
    os.environ['DATABASE_URL'] = database_url
    
    # Initialize the connection pool
    pool = await connection.init_pool()
    
    # Clean database before each test - drop all tables
    async with pool.acquire() as conn:
        # Drop all tables in public schema
        await conn.execute("""
            DO $$ DECLARE
                r RECORD;
            BEGIN
                FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
                    EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
                END LOOP;
            END $$;
        """)
        
        # Drop extensions and recreate
        await conn.execute("DROP EXTENSION IF EXISTS pg_trgm CASCADE")
    
    # Initialize fresh schema
    await schema.init_database(pool)
    
    yield pool
    
    # Close pool after test
    await connection.close_pool()


@pytest_asyncio.fixture(scope="function")
async def test_user(db_pool, temp_data_dir: Path) -> dict:
    """Create a test user and workspace, return user data with auth token."""
    from app import auth
    from app.db import schema
    
    # Use unique username per test to avoid conflicts
    unique_id = secrets.token_hex(4)
    username = f"testuser_{unique_id}"
    
    # Create user via auth module
    user = await auth.create_user(username, "testpassword123")
    
    # Create workspace for user and seed system types
    async with db_pool.acquire() as conn:
        workspace_id = await schema.create_workspace_for_user(conn, int(user["id"]))
        # Get page class ID
        page_row = await conn.fetchrow(
            "SELECT id FROM node WHERE workspace_id = $1 AND uuid = $2",
            workspace_id, schema.SYSTEM_CLASS_UUIDS["page"]
        )
        page_class_id = page_row["id"] if page_row else None
    
    # Generate auth token
    token = auth.create_token(user["id"], user["username"])
    
    return {
        "id": user["id"],
        "username": user["username"],
        "workspace_id": workspace_id,
        "page_class_id": page_class_id,
        "token": token,
        "auth_header": {"Authorization": f"Bearer {token}"}
    }


# ==================== HTTP CLIENT FIXTURES ====================

@pytest_asyncio.fixture(scope="function")
async def client(db_pool) -> AsyncGenerator[AsyncClient, None]:
    """Create an async HTTP client for testing.
    
    The db_pool fixture ensures the database is initialized before
    any HTTP requests are made.
    """
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


# ==================== REPOSITORY FIXTURES ====================

@pytest_asyncio.fixture(scope="function")
async def node_repository(db_pool, test_user):
    """Create a node repository for the test user's workspace."""
    from app.domain.repositories import PostgresNodeRepository
    return PostgresNodeRepository(
        db_pool, test_user["workspace_id"], test_user["page_class_id"], test_user["id"]
    )


@pytest_asyncio.fixture(scope="function")
async def property_repository(db_pool, test_user):
    """Create a property repository for the test user's workspace."""
    from app.domain.repositories import PostgresPropertyRepository
    return PostgresPropertyRepository(db_pool, test_user["workspace_id"], test_user["id"])


@pytest_asyncio.fixture(scope="function")
async def link_repository(db_pool, test_user):
    """Create a link repository for the test user's workspace."""
    from app.domain.repositories import PostgresLinkRepository
    return PostgresLinkRepository(db_pool, test_user["workspace_id"], test_user["id"])


@pytest_asyncio.fixture(scope="function")
async def link_service(node_repository, link_repository):
    """Create a LinkParsingService for the test user's workspace."""
    from app.domain.services.link_service import LinkParsingService
    return LinkParsingService(node_repository, link_repository)


@pytest_asyncio.fixture(scope="function")
async def node_service(node_repository, property_repository, link_service, test_user):
    """Create a NodeService for the test user's workspace."""
    from app.domain.services.node_service import NodeService
    return NodeService(
        node_repository,
        property_repository,
        link_service,
        test_user["page_class_id"],
        pool=node_repository._pool,
        workspace_id=test_user["workspace_id"],
    )


# Alias fixtures for backward compatibility
@pytest.fixture
def test_workspace(test_user):
    """Alias for test_user's workspace data - for backward compatibility."""
    class WorkspaceData:
        def __init__(self, workspace_id):
            self.id = workspace_id
    return WorkspaceData(test_user["workspace_id"])


@pytest.fixture
def test_workspace_id(test_user):
    """Alias for test_user's workspace_id - for backward compatibility."""
    return test_user["workspace_id"]


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

