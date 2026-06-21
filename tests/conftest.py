"""Pytest configuration and fixtures for Notees tests.

This module provides shared fixtures for testing the Notees application
using PostgreSQL. Supports two modes:

1. **External database (default inside the dev container)**: Uses an existing
   PostgreSQL instance. ``compose.dev.yaml`` sets ``TEST_DATABASE_URL`` to the
   shared dev Postgres ``notees_test`` database, so tests run inside the
   backend container do not need Docker-in-Docker.

2. **Testcontainers**: Spins up a fresh PostgreSQL container per session.
   - Requires Docker running
   - Used automatically when ``TEST_DATABASE_URL`` is not set
   - Fully isolated test database

The external URL is normalized before use so raw passwords containing special
characters (``[]@``) are percent-encoded before being passed to asyncpg.
"""
import asyncio
import os
import secrets
import sys
import urllib.parse
from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings
from app.main import app


# Set a test admin password so registration endpoints can bootstrap the first
# admin when the test database is empty. Tests that need a different value can
# override this fixture or set settings.admin_password directly.
@pytest.fixture(autouse=True)
def _set_test_admin_password():
    original = settings.admin_password
    settings.admin_password = "TestAdminPass123!"
    yield
    settings.admin_password = original


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


def _encode_database_url(url: str) -> str:
    """Percent-encode an unescaped database URL so urllib can parse it.

    TEST_DATABASE_URL is often built by interpolating a raw password that may
    contain ``[]@`` characters. Python's URL parser treats unescaped brackets
    as a bracketed host and fails, so we manually extract the password, quote
    it, and reassemble the DSN.
    """
    try:
        urllib.parse.urlparse(url)
        return url
    except ValueError:
        pass

    if "://" not in url:
        return url

    scheme, rest = url.split("://", 1)
    if "/" in rest:
        netloc, path = rest.split("/", 1)
        path = "/" + path
    else:
        netloc, path = rest, ""

    if "@" not in netloc:
        return url

    userinfo, hostport = netloc.rsplit("@", 1)
    if ":" not in userinfo:
        user = userinfo
        password = ""
    else:
        user, password = userinfo.split(":", 1)

    password = urllib.parse.quote(password, safe="")
    return f"{scheme}://{user}:{password}@{hostport}{path}"


@pytest.fixture(scope="session")
def database_url(postgres_container) -> str:
    """Get the database URL for the test PostgreSQL instance."""
    if _EXTERNAL_DB_URL:
        return _encode_database_url(_EXTERNAL_DB_URL)

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
    from app.features import auth as auth_module
    original_users_dir = getattr(auth_module, 'USERS_DIR', None)
    if original_users_dir is not None:
        auth_module.USERS_DIR = data_dir / "users"

    yield data_dir

    # Restore
    settings.database_dir = original_dir
    if original_users_dir is not None:
        auth_module.USERS_DIR = original_users_dir


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
        # uuid-ossp lives in schema public; drop it first so that a stale
        # extension catalog entry does not survive the schema drop and block
        # re-creation of the uuid_generate_v4() function on the next test run.
        # Note: dropping pg_trgm here can segfault Postgres 17-alpine, so we
        # leave it alone and only re-create it below.
        await setup_conn.execute('DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE')

        # Forcibly terminate any other backends still connected to this test
        # database. Leaked connections from background tasks or aborted tests
        # would otherwise block DROP SCHEMA or cause deadlocks. We re-try the
        # drop briefly so transient connections have time to exit.
        for _ in range(5):
            try:
                await setup_conn.execute("DROP SCHEMA IF EXISTS public CASCADE")
                break
            except (
                asyncpg.exceptions.DependentObjectsStillExistError,
                asyncpg.exceptions.DeadlockDetectedError,
            ):
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
        # pg_trgm is created here; uuid-ossp is also created explicitly to avoid
        # a visibility race where init_database's SCHEMA_SQL can execute before
        # the extension functions are resolvable in the same connection.
        await setup_conn.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        await setup_conn.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')

        # Initialize fresh schema on the same connection
        await schema.init_database(setup_conn)
    finally:
        await setup_conn.close()

    # Initialize the connection pool *after* the schema is ready so all pooled
    # connections see the freshly-created tables.
    pool = await connection.init_pool()

    # Clear in-memory auth cache so tests don't see stale user data
    from app.features.auth import auth
    auth._user_cache.clear()

    # Reset per-key rate-limit buckets so leftover request budgets from a
    # previous test do not cause 429 failures on the next test.
    from app.rate_limit import PerKeyBucketFactory
    PerKeyBucketFactory.reset_all()

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
        "_run_node_export_job",
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

    from app.db import schema
    from app.db.connection import get_workspace_dir
    from app.features.auth import auth

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
    from app.features.nodes.repository import PostgresNodeRepository
    return PostgresNodeRepository(
        db_pool, test_user["workspace_id"], test_user["page_class_id"], int(test_user["id"])
    )


@pytest_asyncio.fixture(scope="function")
async def property_repository(db_pool, test_user):
    """Create a property repository for the test user's workspace."""
    from app.features.properties.repository import PostgresPropertyRepository
    return PostgresPropertyRepository(db_pool, test_user["workspace_id"], int(test_user["id"]))


@pytest_asyncio.fixture(scope="function")
async def link_repository(db_pool, test_user):
    """Create a link repository for the test user's workspace."""
    from app.features.nodes.repository import PostgresLinkRepository
    return PostgresLinkRepository(db_pool, test_user["workspace_id"], int(test_user["id"]))


@pytest_asyncio.fixture(scope="function")
async def link_service(node_repository, link_repository):
    """Create a LinkParsingService for the test user's workspace."""
    from app.features.nodes.link_service import LinkParsingService
    return LinkParsingService(node_repository, link_repository)


@pytest_asyncio.fixture(scope="function")
async def mention_repository(db_pool, test_user):
    """Create a mention repository for the test user's workspace."""
    from app.features.nodes.repository import PostgresMentionRepository
    return PostgresMentionRepository(db_pool, test_user["workspace_id"], int(test_user["id"]))


@pytest_asyncio.fixture(scope="function")
async def mention_service(node_repository, mention_repository, link_repository, test_user):
    """Create a MentionService for the test user's workspace."""
    from app.features.nodes.mention_service import MentionService
    return MentionService(
        node_repository,
        mention_repository,
        link_repository,
        user_id=int(test_user["id"]),
    )


@pytest_asyncio.fixture(scope="function")
async def node_service(node_repository, property_repository, link_service, mention_service, test_user, db_pool):
    """Create a NodeService for the test user's workspace."""
    from app.features.nodes.node_service import NodeService
    from app.features.nodes.repository import PostgresNodeViewRepository
    view_repo = PostgresNodeViewRepository(
        db_pool, test_user["workspace_id"], str(test_user["id"])
    )
    return NodeService(
        node_repository,
        property_repository,
        link_service,
        test_user["page_class_id"],
        workspace_id=test_user["workspace_id"],
        mention_service=mention_service,
        view_repo=view_repo,
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

