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
import secrets
import sys
from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings
from app.main import app

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
    1. Dropping and recreating the public schema
    2. Re-running schema initialization
    """
    import asyncpg

    from app.db import connection, schema

    # Set the DATABASE_URL for the connection module
    os.environ['DATABASE_URL'] = database_url
    # Pydantic settings are loaded once at import time; update the cached
    # instance explicitly so the app under test uses the test database.
    settings.database_url = database_url

    # Close any pool left open by a previously aborted test so the fresh
    # schema init below does not race with stale pooled connections.
    await connection.close_pool()

    # Clean database before each test and re-initialize schema on a dedicated,
    # non-pooled connection. Keeping DDL out of the pool guarantees all locks
    # are released and the transaction is fully closed before test code acquires
    # any pool connections.
    setup_conn = await asyncpg.connect(database_url)
    try:
        # Forcibly terminate any other backends still connected to this test
        # database. Leaked connections from background tasks or aborted tests
        # would otherwise block DROP SCHEMA or cause deadlocks. We re-try the
        # drop briefly so transient connections have time to exit.
        for _ in range(5):
            try:
                await setup_conn.execute("DROP SCHEMA IF EXISTS public CASCADE")
                break
            except asyncpg.exceptions.DependencyStillExistsError:
                await setup_conn.execute(
                    """
                    SELECT pg_terminate_backend(pid)
                    FROM pg_stat_activity
                    WHERE datname = current_database()
                      AND pid <> pg_backend_pid()
                """
                )
                await asyncio.sleep(0.05)
        else:
            await setup_conn.execute("DROP SCHEMA IF EXISTS public CASCADE")

        await setup_conn.execute("CREATE SCHEMA public")
        await setup_conn.execute("GRANT ALL ON SCHEMA public TO public")
        await setup_conn.execute("SET search_path TO public")

        # Re-create required extensions in the fresh public schema.
        # pg_trgm is used for full-text-ish substring matching. uuid-ossp is
        # created by init_database itself because running CREATE EXTENSION IF
        # NOT EXISTS twice in the same connection before SCHEMA_SQL triggers an
        # asyncpg/PostgreSQL unique-violation on pg_extension_name_index.
        await setup_conn.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

        # Initialize fresh schema on the same connection
        await schema.init_database(setup_conn)
    finally:
        await setup_conn.close()

    # Initialize the connection pool *after* the schema is ready so all pooled
    # connections see the freshly-created tables.
    pool = await connection.init_pool()

    # Clear in-memory auth cache so tests don't see stale user data
    from app import auth
    auth._user_cache.clear()

    yield pool

    # Cancel known application background tasks (e.g. export jobs) so they don't
    # hold pooled connections open across test boundaries. We identify tasks by
    # their coroutine function name to avoid cancelling pytest-asyncio internals.
    def _task_coro_name(task: asyncio.Task) -> str | None:
        coro = task.get_coro()
        if coro is None:
            return None
        return getattr(coro, "__qualname__", None) or getattr(
            getattr(coro, "cr_code", None), "co_name", None
        )

    background_task_names = {
        "_run_batch_export",
        "_run_export_job",
        "_run_lock_timer",
        "_run_redis_loop",
    }
    current_task = asyncio.current_task()
    pending = [
        t
        for t in asyncio.all_tasks()
        if t is not current_task
        and not t.done()
        and _task_coro_name(t) in background_task_names
    ]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)

    # Close pool after test
    await connection.close_pool()


@pytest_asyncio.fixture(scope="function")
async def test_user(db_pool, temp_data_dir: Path) -> dict:
    """Create a test user and workspace, return user data with auth token."""
    import shutil

    from app import auth
    from app.db import schema
    from app.db.connection import get_workspace_dir

    # Use unique email per test to avoid conflicts
    unique_id = secrets.token_hex(4)
    email = f"testuser_{unique_id}@example.com"

    # Create user via auth module
    user = await auth.create_user(email, "testpassword123")

    # Create workspace for user and seed system types
    async with db_pool.acquire() as conn:
        workspace_id = await schema.create_workspace_for_user(conn, int(user["id"]))
        # Get workspace UUID for cleanup
        ws_row = await conn.fetchrow(
            "SELECT uuid::text as uuid FROM workspace WHERE id = $1",
            workspace_id,
        )
        workspace_uuid = ws_row["uuid"] if ws_row else None
        # Get page class ID
        page_row = await conn.fetchrow(
            "SELECT id FROM node WHERE workspace_id = $1 AND uuid = $2",
            workspace_id, schema.SYSTEM_CLASS_UUIDS["page"]
        )
        page_class_id = page_row["id"] if page_row else None

    # Generate auth token
    token = auth.create_token(user["id"], user["email"], user["role"])

    user_data = {
        "id": user["id"],
        "email": user["email"],
        "workspace_id": workspace_id,
        "workspace_uuid": workspace_uuid,
        "page_class_id": page_class_id,
        "token": token,
        "auth_header": {"Authorization": f"Bearer {token}"},
    }

    yield user_data

    # Clean up workspace directory on disk (DB is cleaned by db_pool)
    if workspace_uuid:
        ws_dir = get_workspace_dir(workspace_uuid)
        if ws_dir.exists():
            shutil.rmtree(ws_dir)


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
        db_pool, test_user["workspace_id"], test_user["page_class_id"], int(test_user["id"])
    )


@pytest_asyncio.fixture(scope="function")
async def property_repository(db_pool, test_user):
    """Create a property repository for the test user's workspace."""
    from app.domain.repositories import PostgresPropertyRepository
    return PostgresPropertyRepository(db_pool, test_user["workspace_id"], int(test_user["id"]))


@pytest_asyncio.fixture(scope="function")
async def link_repository(db_pool, test_user):
    """Create a link repository for the test user's workspace."""
    from app.domain.repositories import PostgresLinkRepository
    return PostgresLinkRepository(db_pool, test_user["workspace_id"], int(test_user["id"]))


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

