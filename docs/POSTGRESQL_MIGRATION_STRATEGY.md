# PostgreSQL Migration Strategy for Notees

## Executive Summary

This document outlines a comprehensive migration strategy for transitioning Notees from SQLite to PostgreSQL, enabling future multi-user node-sharing and collaboration features. The migration involves database schema changes, codebase updates, and infrastructure modifications.

**Current State:** Single-user SQLite databases per user (file-based)  
**Target State:** Shared PostgreSQL database with multi-tenant architecture

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Tables and Schema Overview](#2-tables-and-schema-overview)
3. [SQLite-Specific Features Identified](#3-sqlite-specific-features-identified)
4. [Code Areas Impacted](#4-code-areas-impacted)
5. [Risks and Challenges](#5-risks-and-challenges)
6. [Migration Strategy](#6-migration-strategy)
7. [PostgreSQL Schema Design](#7-postgresql-schema-design)
8. [Multi-User and Node-Sharing Architecture](#8-multi-user-and-node-sharing-architecture)
9. [Implementation Roadmap](#9-implementation-roadmap)
10. [Dev Environment and Docker Changes](#10-dev-environment-and-docker-changes)

---

## 1. Current Architecture Analysis

### 1.1 Database Architecture

Notees currently uses a **per-user SQLite database** model:

```
data/users/{user_id}/databases/{db_name}/
├── db.sqlite      # SQLite database file
└── assets/        # Uploaded files (images, etc.)
```

**Key characteristics:**
- Each user has isolated databases
- Database selection is per-user (active database tracking)
- No cross-user data sharing capability
- File-based locking via SQLite

### 1.2 Hexagonal Architecture

The codebase follows hexagonal (ports & adapters) architecture:

```
app/
├── domain/
│   ├── entities/        # Pure domain objects (Node, Property, Link, User)
│   ├── services/        # Domain services (NodeService, LinkParsingService)
│   └── repositories/
│       ├── interfaces.py        # Abstract repository protocols (ports)
│       ├── sqlite_node.py       # SQLite implementation (adapter)
│       ├── sqlite_property.py   # SQLite implementation (adapter)
│       └── sqlite_link.py       # SQLite implementation (adapter)
├── routers/             # FastAPI endpoints
└── db/
    ├── schema.py        # Schema DDL and migrations
    └── connection.py    # Connection management
```

**Advantage:** The repository interface pattern isolates database-specific code, making migration more manageable.

### 1.3 Connection Management

- **Library:** `aiosqlite` for async SQLite access
- **Connection Pattern:** Connections created per-request, no pooling
- **Configuration:**
  ```python
  await conn.execute("PRAGMA busy_timeout = 5000")
  await conn.execute("PRAGMA journal_mode = WAL")  # In some paths
  await conn.execute("PRAGMA foreign_keys = ON")
  ```

---

## 2. Tables and Schema Overview

### 2.1 Core Tables

| Table | Purpose | Rows (typical) |
|-------|---------|----------------|
| `node` | Core entity - pages, blocks, types, journals | High |
| `user` | User accounts | Low |
| `property` | Property definitions | Medium |
| `node_property` | Property assignments to nodes | High |
| `property_value_scalar` | Integer, float, boolean values | Medium |
| `property_value_relation` | Node reference values (tags, types) | High |
| `property_value_selection` | Selection property values | Low |
| `property_selection_line` | Selection options | Low |
| `property_type_filter` | Type filters for node properties | Low |
| `type_property` | Properties inherited by type | Low |
| `type_extends` | Type inheritance | Low |
| `node_link` | Parsed links from content | High |
| `inline_type` | Inline type references | Medium |
| `node_comment` | Comment attachments | Low |
| `node_activity` | Activity log | High |
| `link_click` | Link click tracking | Medium |
| `settings` | Key-value user settings | Low |
| `schema_meta` | Schema versioning | Low |

### 2.2 Node Table Schema

The `node` table is the central entity with these key fields:

```sql
CREATE TABLE node (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    icon TEXT,
    color TEXT,
    parent_id INTEGER REFERENCES node(id),
    page_id INTEGER REFERENCES node(id),
    sequence INTEGER DEFAULT 0,
    collapsed INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    -- Type flags (denormalized for fast queries)
    is_type INTEGER DEFAULT 0,
    is_page INTEGER DEFAULT 0,
    is_day INTEGER DEFAULT 0,
    is_month INTEGER DEFAULT 0,
    is_year INTEGER DEFAULT 0,
    is_asset INTEGER DEFAULT 0,
    is_template INTEGER DEFAULT 0,
    is_comment INTEGER DEFAULT 0,
    usable_in TEXT DEFAULT 'both',
    cover_image_id INTEGER REFERENCES node(id),
    types_path TEXT DEFAULT '[]',  -- JSON array
    open_date TEXT,
    create_date TEXT NOT NULL,
    write_date TEXT NOT NULL,
    create_uid INTEGER REFERENCES user(id),
    write_uid INTEGER REFERENCES user(id)
);
```

### 2.3 UUID Strategy

Current UUID patterns:
- **Regular nodes:** UUID v4 (e.g., `3fa85f64-5717-4562-b3fc-2c963f66afa6`)
- **System types:** Fixed UUIDs (e.g., `00000000-0000-0000-0001-000000000001` for "type")
- **Date nodes:** Date-based (e.g., `20260122` for day, `20260100` for month, `20260000` for year)

---

## 3. SQLite-Specific Features Identified

### 3.1 Auto-Increment Primary Keys

**Current:** `INTEGER PRIMARY KEY AUTOINCREMENT`

```python
cursor = await self._conn.execute(...)
node_id = cursor.lastrowid  # SQLite-specific
```

**PostgreSQL equivalent:** `SERIAL` or `BIGSERIAL`, use `RETURNING id`

### 3.2 Boolean Storage

**Current:** Integers (0/1) stored in `INTEGER` columns

```python
int(data.collapsed)  # Convert bool to int
bool(row['is_page'])  # Convert int to bool
```

**PostgreSQL:** Native `BOOLEAN` type

### 3.3 JSON Storage

**Current:** JSON stored as TEXT, parsed in Python

```python
types_path TEXT DEFAULT '[]'  # JSON array as text
json.loads(row['types_path'])  # Manual parsing
```

**PostgreSQL:** Native `JSONB` type with indexing

### 3.4 Date/Time Functions

**Current:** ISO strings stored as TEXT

```python
created_at TEXT NOT NULL DEFAULT (datetime('now'))  # SQLite function
datetime.fromisoformat(created_at)  # Python parsing
```

**PostgreSQL:** Native `TIMESTAMPTZ` type

### 3.5 PRAGMA Statements

**Current:**
```python
await conn.execute("PRAGMA busy_timeout = 5000")
await conn.execute("PRAGMA journal_mode = WAL")
await conn.execute("PRAGMA foreign_keys = ON")
```

**PostgreSQL:** Not applicable - use connection pool settings and default FK behavior

### 3.6 UPSERT Syntax

**Current:** `INSERT OR IGNORE INTO` / `INSERT OR REPLACE`

**PostgreSQL:** `INSERT ... ON CONFLICT DO NOTHING/UPDATE`

### 3.7 Partial Indexes

**Current:** 
```sql
CREATE INDEX idx_node_is_page ON node(is_page) WHERE is_page = 1;
```

**PostgreSQL:** Fully supported (same syntax)

### 3.8 Full-Text Search

**Current:** Not using FTS5 (using `LIKE` queries)

```python
"SELECT * FROM node WHERE name LIKE ? LIMIT ?"
```

**PostgreSQL opportunity:** Use `tsvector`/`tsquery` for proper full-text search

### 3.9 Table Information Queries

**Current:** `PRAGMA table_info(node)` for migrations

**PostgreSQL:** Query `information_schema.columns`

---

## 4. Code Areas Impacted

### 4.1 Repository Layer (HIGH IMPACT)

| File | Changes Required |
|------|------------------|
| `sqlite_node.py` (615 lines) | Full rewrite to PostgreSQL |
| `sqlite_property.py` (1264 lines) | Full rewrite to PostgreSQL |
| `sqlite_link.py` (240 lines) | Full rewrite to PostgreSQL |
| `interfaces.py` | May need async connection type hints |

**Key patterns to change:**
- `aiosqlite.Connection` → `asyncpg.Connection` or SQLAlchemy async
- `cursor.lastrowid` → `RETURNING id` clause
- `?` placeholders → `$1, $2, ...` (asyncpg) or `:param` (SQLAlchemy)
- `executemany` patterns
- Row factory patterns

### 4.2 Schema Module (HIGH IMPACT)

| File | Changes Required |
|------|------------------|
| `app/db/schema.py` (852 lines) | Complete rewrite of DDL |

**Changes:**
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`
- `INTEGER` (boolean) → `BOOLEAN`
- `TEXT` (JSON) → `JSONB`
- `TEXT` (datetime) → `TIMESTAMPTZ`
- `datetime('now')` → `NOW()` or `CURRENT_TIMESTAMP`
- Remove PRAGMA statements
- Rewrite migration logic using `information_schema`

### 4.3 Connection Module (HIGH IMPACT)

| File | Changes Required |
|------|------------------|
| `app/db/connection.py` (159 lines) | Complete rewrite |

**Changes:**
- Replace file-based database selection with schema/tenant selection
- Implement connection pooling (asyncpg pool or SQLAlchemy)
- Handle PostgreSQL connection strings
- Remove file path logic

### 4.4 Export/Import (MEDIUM IMPACT)

| File | Changes Required |
|------|------------------|
| `app/db/export.py` (267 lines) | Update connection handling |
| `app/db/sync.py` (176 lines) | Update SQL syntax |

### 4.5 Graph Operations (MEDIUM IMPACT)

| File | Changes Required |
|------|------------------|
| `app/db/graph.py` | Update connection and SQL patterns |

### 4.6 Routers (LOW IMPACT)

| File | Changes Required |
|------|------------------|
| `app/routers/nodes.py` (2590 lines) | Minimal - uses services |
| Other routers | Minimal - uses services |

**Note:** Routers primarily use domain services, so changes are minimal if repository interfaces are maintained.

### 4.7 Dev Scripts (MEDIUM IMPACT)

| File | Changes Required |
|------|------------------|
| `run_dev.py` (288 lines) | Add PostgreSQL startup |
| `Dockerfile` | Add PostgreSQL client |
| `Dockerfile.dev` | Add PostgreSQL client |
| `compose.yaml` | Add PostgreSQL service |
| `compose.dev.yaml` | Add PostgreSQL service |

### 4.8 Backup Module (MEDIUM IMPACT)

| File | Changes Required |
|------|------------------|
| `app/backup.py` (144 lines) | Change from file copy to pg_dump |

### 4.9 Tests (MEDIUM IMPACT)

| File | Changes Required |
|------|------------------|
| `tests/conftest.py` | Create test database, not temp files |
| All test files | May need transaction rollback pattern |
| New test files | Migration tests, concurrency tests |

**Required Test Categories:**

1. **Migration Tests** - Test with real SQLite dumps
   ```python
   @pytest.fixture
   def sample_sqlite_dump(tmp_path):
       """Create a sample SQLite database for migration testing."""
       db_path = tmp_path / "test.sqlite"
       # Populate with realistic data
       return db_path
   
   async def test_migration_node_counts(sample_sqlite_dump, pg_pool):
       """Verify all nodes are migrated correctly."""
       result = await migrate_user_data("test_user", sample_sqlite_dump, pg_pool)
       assert result.nodes_migrated == result.sqlite_node_count
       assert len(result.errors) == 0
   
   async def test_migration_link_integrity(sample_sqlite_dump, pg_pool):
       """Verify link relationships are preserved."""
       # ...
   
   async def test_migration_resume_on_failure(sample_sqlite_dump, pg_pool):
       """Test that migration can resume from last checkpoint."""
       # ...
   ```

2. **Concurrency Tests** - Multi-user scenarios
   ```python
   async def test_optimistic_lock_conflict(pg_pool):
       """Test that concurrent edits are detected."""
       # Create node
       node = await repo.create(NodeCreateData(name="Test"))
       
       # Simulate concurrent reads
       version = node.version
       
       # First update succeeds
       await repo.update(
           node.id, 
           NodeUpdateData(name="Update 1"),
           expected_version=version
       )
       
       # Second update with stale version fails
       with pytest.raises(OptimisticLockError):
           await repo.update(
               node.id,
               NodeUpdateData(name="Update 2"),
               expected_version=version  # Stale!
           )
   
   async def test_concurrent_block_resequencing(pg_pool):
       """Test concurrent block moves don't corrupt sequence."""
       # Create page with blocks
       # Simulate concurrent drag-and-drop
       # Verify final sequence is consistent
   
   async def test_workspace_permission_isolation(pg_pool):
       """Test that users can only access their workspaces."""
       # ...
   ```

3. **Performance Tests**
   ```python
   @pytest.mark.slow
   async def test_backlink_query_performance(pg_pool, large_dataset):
       """Backlinks should return in < 100ms for pages with many links."""
       import time
       start = time.monotonic()
       links = await repo.get_backlinks(popular_page_id)
       elapsed = time.monotonic() - start
       assert elapsed < 0.1  # 100ms
   ```

---

## 5. Risks and Challenges

### 5.1 Multi-User Concurrency

**Risk:** Write conflicts when multiple users edit the same node tree

**Challenges:**
- Block sequence reordering during concurrent edits
- Parent chain modifications (moving blocks)
- Link table updates during content changes

**Mitigations:**
- Implement optimistic locking with `version` column
- Use `SELECT ... FOR UPDATE` for critical operations
- Consider event sourcing for collaborative editing

### 5.2 Backlinks and Transclusions

**Risk:** Performance degradation with complex backlink queries across many users

**Current query pattern:**
```python
SELECT nl.*, n.page_id as source_page_id
FROM node_link nl
JOIN node n ON nl.source_node_id = n.id
WHERE nl.target_node_id = ?
```

**Mitigations:**
- Add composite indexes
- Consider materialized views for heavy backlink pages
- Implement caching layer (Redis)

### 5.3 Hierarchical Queries

**Risk:** Recursive parent chain walks become expensive

**Current pattern:**
```python
while current_id and current_id not in visited:
    cursor = await self._conn.execute(
        "SELECT id, is_page, parent_id FROM node WHERE id = ?",
        (current_id,)
    )
```

**PostgreSQL solution:** Use `WITH RECURSIVE` CTEs

```sql
WITH RECURSIVE ancestors AS (
    SELECT id, parent_id, is_page, 1 as depth
    FROM node WHERE id = $1
    UNION ALL
    SELECT n.id, n.parent_id, n.is_page, a.depth + 1
    FROM node n
    JOIN ancestors a ON n.id = a.parent_id
)
SELECT * FROM ancestors WHERE is_page = true LIMIT 1;
```

### 5.4 Data Migration

**Risk:** Data loss or corruption during migration

**Challenges:**
- Maintaining referential integrity
- UUID collisions across users
- Date UUID format compatibility

**Mitigations:**
- Run parallel systems during migration
- Implement rollback capability
- Extensive validation scripts

### 5.5 Performance Bottlenecks

**Current SQLite advantages being lost:**
- No network latency (file-local)
- Simpler locking model

**PostgreSQL considerations:**
- Connection pooling essential
- Network round-trips for each query
- Need proper indexing strategy

### 5.6 Export/Import Consistency

**Risk:** Import of SQLite exports into PostgreSQL-based system

**Mitigations:**
- Maintain export format compatibility
- Add format version field
- Support both import paths during transition

**Export Format Specification:**

```python
# Export format should be DB-agnostic
EXPORT_FORMAT_VERSION = "2.0"  # Increment on breaking changes

@dataclass
class NotesExport:
    """Database-agnostic export format."""
    format_version: str = EXPORT_FORMAT_VERSION
    export_date: str = field(default_factory=utc_now_iso)
    source_type: str = "postgresql"  # or "sqlite"
    
    # Workspace metadata (for multi-user)
    workspace: Optional[WorkspaceExport] = None
    
    # Content
    nodes: List[NodeExport] = field(default_factory=list)
    properties: List[PropertyExport] = field(default_factory=list)
    links: List[LinkExport] = field(default_factory=list)
    
    # Checksums for validation
    node_count: int = 0
    checksum: Optional[str] = None  # SHA256 of content


@dataclass
class WorkspaceExport:
    """Workspace info for shared imports."""
    uuid: str
    name: str
    members: List[WorkspaceMemberExport] = field(default_factory=list)


@dataclass
class NodeExport:
    """Node in export format - uses UUIDs, not internal IDs."""
    uuid: str
    name: str
    parent_uuid: Optional[str] = None  # UUID reference
    page_uuid: Optional[str] = None
    sequence: int = 0
    # ... other fields using UUIDs for references
```

**Import Validation:**

```python
async def import_notes(
    data: NotesExport,
    target_workspace_id: int,
    user_id: int
) -> ImportResult:
    """Import notes into a workspace."""
    result = ImportResult()
    
    # 1. Validate format version
    if not is_compatible_version(data.format_version):
        raise ImportError(
            f"Unsupported format version: {data.format_version}"
        )
    
    # 2. Validate checksum if present
    if data.checksum and not verify_checksum(data):
        raise ImportError("Checksum mismatch - export may be corrupted")
    
    # 3. Build UUID → ID mapping during import
    uuid_to_id = {}
    
    # 4. Import in dependency order
    # ... (similar to migration batching)
    
    return result
```

---

## 6. Migration Strategy

### 6.1 Approach: Repository Adapter Pattern

**Recommended approach:** Create PostgreSQL repository implementations alongside SQLite

```
app/domain/repositories/
├── interfaces.py          # Unchanged
├── sqlite_node.py         # Keep for migration period
├── sqlite_property.py     # Keep for migration period
├── sqlite_link.py         # Keep for migration period
├── postgres_node.py       # NEW
├── postgres_property.py   # NEW
└── postgres_link.py       # NEW
```

**Benefits:**
- Side-by-side testing
- Gradual rollout possible
- Easy rollback if issues found

### 6.2 Phase 1: Infrastructure Setup (Week 1-2)

1. **Add PostgreSQL to Docker**
   - Update `compose.yaml` and `compose.dev.yaml`
   - Add initialization scripts
   - Configure connection pooling

2. **Create PostgreSQL Schema**
   - Write complete DDL in new `app/db/postgres_schema.py`
   - Include all indexes
   - Add migration table

3. **Update Connection Layer**
   - Add `asyncpg` or SQLAlchemy async
   - Implement connection pooling
   - Support both SQLite and PostgreSQL during transition

### 6.3 Phase 2: Repository Implementation (Week 3-6)

1. **Create PostgreSQL Repositories**
   - `PostgresNodeRepository`
   - `PostgresPropertyRepository`
   - `PostgresLinkRepository`
   - `PostgresUserRepository`

2. **Implement Connection Factory**
   ```python
   def get_repository(db_type: str, connection) -> NodeRepository:
       if db_type == "postgres":
           return PostgresNodeRepository(connection)
       return SQLiteNodeRepository(connection)
   ```

3. **Update Tests**
   - Create fixtures for both database types
   - Run tests against both

### 6.4 Phase 3: Data Migration (Week 7-8)

1. **Create Migration Script with Batching**
   ```python
   from typing import List, Dict, Any
   import asyncio
   
   BATCH_SIZE = 500  # Adjust based on memory/network
   
   async def migrate_user_data(
       user_id: str, 
       sqlite_path: Path,
       pg_pool: asyncpg.Pool
   ) -> MigrationResult:
       """Migrate a user's SQLite database to PostgreSQL."""
       result = MigrationResult(user_id=user_id)
       
       async with aiosqlite.connect(sqlite_path) as sqlite_conn:
           sqlite_conn.row_factory = aiosqlite.Row
           
           # 1. Migrate nodes in topological order (parents first)
           await migrate_nodes_batched(sqlite_conn, pg_pool, result)
           
           # 2. Migrate properties
           await migrate_properties_batched(sqlite_conn, pg_pool, result)
           
           # 3. Migrate node_property assignments
           await migrate_node_properties_batched(sqlite_conn, pg_pool, result)
           
           # 4. Migrate property values
           await migrate_property_values_batched(sqlite_conn, pg_pool, result)
           
           # 5. Migrate links
           await migrate_links_batched(sqlite_conn, pg_pool, result)
           
           # 6. Validate
           await validate_migration(sqlite_conn, pg_pool, result)
       
       return result
   
   
   async def migrate_nodes_batched(
       sqlite_conn: aiosqlite.Connection,
       pg_pool: asyncpg.Pool,
       result: MigrationResult
   ):
       """Migrate nodes with proper ordering and batching."""
       # First pass: Get all nodes
       cursor = await sqlite_conn.execute(
           "SELECT * FROM node ORDER BY parent_id NULLS FIRST, id"
       )
       all_nodes = await cursor.fetchall()
       
       # Build batches respecting foreign key order
       batches = build_fk_ordered_batches(all_nodes, BATCH_SIZE)
       
       async with pg_pool.acquire() as conn:
           for batch in batches:
               # Validate parent/page references exist before insert
               await validate_fk_references(conn, batch)
               
               # Use COPY for bulk insert (fastest)
               await conn.copy_records_to_table(
                   'node',
                   records=[
                       transform_node_row(row) for row in batch
                   ],
                   columns=NODE_COLUMNS
               )
               result.nodes_migrated += len(batch)
   
   
   def build_fk_ordered_batches(
       nodes: List[Dict], 
       batch_size: int
   ) -> List[List[Dict]]:
       """Order nodes so parents are inserted before children."""
       # Topological sort based on parent_id
       id_set = {n['id'] for n in nodes}
       result = []
       remaining = list(nodes)
       
       while remaining:
           # Find nodes whose parent is either NULL or already processed
           batch = [
               n for n in remaining
               if n['parent_id'] is None or n['parent_id'] not in id_set
           ]
           
           if not batch:
               # Circular reference - shouldn't happen, but handle it
               batch = remaining[:batch_size]
           
           result.append(batch[:batch_size])
           processed_ids = {n['id'] for n in batch[:batch_size]}
           id_set -= processed_ids
           remaining = [n for n in remaining if n['id'] in id_set]
       
       return result
   
   
   async def validate_fk_references(
       conn: asyncpg.Connection, 
       batch: List[Dict]
   ):
       """Validate foreign key references exist before insert."""
       parent_ids = {n['parent_id'] for n in batch if n['parent_id']}
       page_ids = {n['page_id'] for n in batch if n['page_id']}
       
       if parent_ids or page_ids:
           all_ids = parent_ids | page_ids
           existing = await conn.fetch(
               "SELECT id FROM node WHERE id = ANY($1)",
               list(all_ids)
           )
           existing_set = {r['id'] for r in existing}
           
           missing = all_ids - existing_set
           if missing:
               raise MigrationError(
                   f"Missing FK references: {missing}"
               )
   ```

2. **Migration Status Tracking**
   ```sql
   -- Track migration progress (allows resume on failure)
   CREATE TABLE migration_status (
       id SERIAL PRIMARY KEY,
       user_id VARCHAR(255) NOT NULL,
       workspace_id INTEGER REFERENCES workspace(id),
       sqlite_path TEXT NOT NULL,
       status VARCHAR(50) NOT NULL DEFAULT 'pending',
       -- Counts for validation
       sqlite_node_count INTEGER,
       postgres_node_count INTEGER,
       sqlite_link_count INTEGER,
       postgres_link_count INTEGER,
       sqlite_property_count INTEGER,
       postgres_property_count INTEGER,
       -- Progress tracking
       last_migrated_node_id INTEGER,
       last_migrated_link_id INTEGER,
       error_message TEXT,
       started_at TIMESTAMPTZ,
       completed_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   
   CREATE INDEX idx_migration_status_user ON migration_status(user_id);
   CREATE INDEX idx_migration_status_status ON migration_status(status);
   ```

3. **Handle ID Mapping**
   - SQLite uses auto-increment IDs
   - Need to preserve relationships
   - Consider using UUIDs as primary lookup during migration
   - **ID Mapping Table** for cross-reference:
     ```sql
     CREATE TEMPORARY TABLE id_mapping (
         sqlite_id INTEGER PRIMARY KEY,
         postgres_id INTEGER NOT NULL,
         entity_type VARCHAR(50) NOT NULL
     );
     ```

4. **Validate Data Integrity**
   - Compare node counts
   - Verify link relationships
   - Check property values
   - **Validation queries:**
     ```python
     async def validate_migration(
         sqlite_conn, pg_pool, result: MigrationResult
     ):
         validations = [
             ('nodes', 'SELECT COUNT(*) FROM node'),
             ('links', 'SELECT COUNT(*) FROM node_link'),
             ('properties', 'SELECT COUNT(*) FROM property'),
             ('node_properties', 'SELECT COUNT(*) FROM node_property'),
         ]
         
         for name, query in validations:
             sqlite_count = (await (await sqlite_conn.execute(query)).fetchone())[0]
             async with pg_pool.acquire() as conn:
                 pg_count = await conn.fetchval(query)
             
             if sqlite_count != pg_count:
                 result.add_error(
                     f"{name} count mismatch: SQLite={sqlite_count}, PG={pg_count}"
                 )
             else:
                 result.add_validation(name, sqlite_count)
     ```

### 6.5 Phase 4: Multi-User Foundation (Week 9-12)

1. **Add Tenant/Workspace Model**
   - Create `workspace` table
   - Add `workspace_id` foreign key to nodes
   - Implement workspace permissions

2. **Update Services**
   - Add workspace context to all operations
   - Implement permission checks

3. **Update API**
   - Add workspace selection endpoints
   - Update node endpoints with workspace context

### 6.6 Rollback Strategy

1. **Keep SQLite exports** as backup
2. **Maintain dual-write** during transition
3. **Feature flag** for database selection
4. **Clear rollback procedure** documented

---

## 7. PostgreSQL Schema Design

### 7.1 Core Tables

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- User table (moved to central schema)
CREATE TABLE "user" (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Workspace for multi-tenant support
CREATE TABLE workspace (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES "user"(id),
    is_shared BOOLEAN DEFAULT FALSE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Workspace membership
CREATE TABLE workspace_member (
    id SERIAL PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'viewer', -- owner, editor, viewer
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, user_id)
);

-- Node table with workspace support
CREATE TABLE node (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    icon VARCHAR(100),
    color VARCHAR(50),
    parent_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    page_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    sequence INTEGER DEFAULT 0,
    collapsed BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    version INTEGER DEFAULT 1, -- For optimistic locking
    -- Type flags
    is_type BOOLEAN DEFAULT FALSE,
    is_page BOOLEAN DEFAULT FALSE,
    is_day BOOLEAN DEFAULT FALSE,
    is_month BOOLEAN DEFAULT FALSE,
    is_year BOOLEAN DEFAULT FALSE,
    is_asset BOOLEAN DEFAULT FALSE,
    is_template BOOLEAN DEFAULT FALSE,
    is_comment BOOLEAN DEFAULT FALSE,
    usable_in VARCHAR(20) DEFAULT 'both',
    cover_image_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    types_path JSONB DEFAULT '[]'::jsonb,
    open_date TIMESTAMPTZ,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    create_uid INTEGER REFERENCES "user"(id),
    write_uid INTEGER REFERENCES "user"(id)
);

-- Indexes for node table
CREATE INDEX idx_node_workspace ON node(workspace_id);
CREATE INDEX idx_node_uuid ON node(uuid);
CREATE INDEX idx_node_parent_id ON node(parent_id);
CREATE INDEX idx_node_page_id ON node(page_id);
CREATE INDEX idx_node_name ON node(name);
CREATE INDEX idx_node_is_page ON node(is_page) WHERE is_page = TRUE;
CREATE INDEX idx_node_is_type ON node(is_type) WHERE is_type = TRUE;
CREATE INDEX idx_node_is_day ON node(is_day) WHERE is_day = TRUE;
CREATE INDEX idx_node_open_date ON node(open_date) WHERE open_date IS NOT NULL;
CREATE INDEX idx_node_types_path ON node USING GIN (types_path);

-- Property definition
CREATE TABLE property (
    id SERIAL PRIMARY KEY,
    uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    workspace_id INTEGER REFERENCES workspace(id) ON DELETE CASCADE, -- NULL for global
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(100),
    type VARCHAR(50) NOT NULL DEFAULT 'text',
    is_multi BOOLEAN DEFAULT FALSE,
    is_system BOOLEAN DEFAULT FALSE,
    is_local BOOLEAN DEFAULT FALSE,
    node_id INTEGER REFERENCES node(id) ON DELETE CASCADE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (is_local = TRUE OR node_id IS NULL),
    CHECK (type NOT IN ('text', 'image') OR is_multi = FALSE)
);

-- Node property assignment
CREATE TABLE node_property (
    id SERIAL PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(node_id, property_id)
);

-- Scalar property values
CREATE TABLE property_value_scalar (
    id SERIAL PRIMARY KEY,
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    value_text TEXT,
    value_boolean BOOLEAN,
    value_float DOUBLE PRECISION,
    value_integer BIGINT,
    "order" INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Relation property values
CREATE TABLE property_value_relation (
    id SERIAL PRIMARY KEY,
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    "order" INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Selection options
CREATE TABLE property_selection_line (
    id SERIAL PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(100),
    "order" INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Selection property values
CREATE TABLE property_value_selection (
    id SERIAL PRIMARY KEY,
    node_property_id INTEGER NOT NULL REFERENCES node_property(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    selection_line_id INTEGER NOT NULL REFERENCES property_selection_line(id) ON DELETE RESTRICT,
    "order" INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    write_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Property type filters
CREATE TABLE property_type_filter (
    id SERIAL PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    UNIQUE(property_id, type_node_id)
);

-- Type properties (inherited by typed nodes)
CREATE TABLE type_property (
    id SERIAL PRIMARY KEY,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    hidden BOOLEAN DEFAULT FALSE,
    default_integer BIGINT,
    default_float DOUBLE PRECISION,
    default_text TEXT,
    default_boolean BOOLEAN,
    default_node_id INTEGER REFERENCES node(id),
    default_selection_id INTEGER REFERENCES property_selection_line(id),
    UNIQUE(type_node_id, property_id)
);

-- Type inheritance
CREATE TABLE type_extends (
    id SERIAL PRIMARY KEY,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    extends_type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    UNIQUE(type_node_id, extends_type_node_id)
);

-- Node links (backlinks)
CREATE TABLE node_link (
    id SERIAL PRIMARY KEY,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    property_id INTEGER REFERENCES property(id) ON DELETE CASCADE,
    is_tag BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_link_source ON node_link(source_node_id);
CREATE INDEX idx_link_target ON node_link(target_node_id);
CREATE INDEX idx_link_property ON node_link(property_id) WHERE property_id IS NOT NULL;
-- Composite index for common join pattern (backlinks query)
CREATE INDEX idx_link_source_target ON node_link(source_node_id, target_node_id);
-- Composite for property-based link queries
CREATE INDEX idx_link_target_property ON node_link(target_node_id, property_id);

-- Inline type references
CREATE TABLE inline_type (
    id SERIAL PRIMARY KEY,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    type_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inline_type_source ON inline_type(source_node_id);
CREATE INDEX idx_inline_type_target ON inline_type(type_node_id);

-- Node comments
CREATE TABLE node_comment (
    id SERIAL PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    comment_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    sequence INTEGER DEFAULT 0,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(node_id, comment_node_id)
);

-- Activity log
CREATE TABLE node_activity (
    id SERIAL PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    target_node_id INTEGER REFERENCES node(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
    create_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_node ON node_activity(node_id);
CREATE INDEX idx_activity_date ON node_activity(create_date);

-- Link click tracking
CREATE TABLE link_click (
    id SERIAL PRIMARY KEY,
    source_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    click_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX idx_click_source ON link_click(source_node_id);
CREATE INDEX idx_click_target ON link_click(target_node_id);
CREATE INDEX idx_click_date ON link_click(click_date);

-- User settings (per workspace)
CREATE TABLE settings (
    workspace_id INTEGER REFERENCES workspace(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value JSONB,
    PRIMARY KEY (workspace_id, key)
);

-- Schema metadata with version tracking
CREATE TABLE schema_meta (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize schema version
INSERT INTO schema_meta (key, value) VALUES 
    ('db_schema_version', '1'),
    ('migration_version', '2026.01.22'),
    ('created_at', NOW()::text);
```

### 7.2 Full-Text Search Enhancement

```sql
-- Add full-text search column with language support
ALTER TABLE node ADD COLUMN search_vector tsvector;
ALTER TABLE node ADD COLUMN search_language VARCHAR(50) DEFAULT 'english';

-- Create GIN index for fast searching
CREATE INDEX idx_node_search ON node USING GIN (search_vector);

-- Trigger to update search vector with configurable language
CREATE OR REPLACE FUNCTION update_node_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    -- Use node's language or fall back to workspace/default
    NEW.search_vector := to_tsvector(
        COALESCE(NEW.search_language, 'english')::regconfig,
        COALESCE(NEW.name, '')
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER node_search_update
    BEFORE INSERT OR UPDATE OF name, search_language ON node
    FOR EACH ROW
    EXECUTE FUNCTION update_node_search_vector();
```

**Multi-Language Support:**

```python
# Supported languages for full-text search
SUPPORTED_FTS_LANGUAGES = [
    'simple',      # No stemming (good for code/technical)
    'english',
    'spanish',
    'french',
    'german',
    'portuguese',
    'russian',
    'japanese',    # Requires pg_bigm or similar extension
]

async def search_nodes(
    query: str,
    workspace_id: int,
    language: str = 'english',
    limit: int = 50
) -> List[Node]:
    """Full-text search across nodes."""
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT *, ts_rank(search_vector, query) AS rank
            FROM node, plainto_tsquery($1::regconfig, $2) query
            WHERE workspace_id = $3
              AND search_vector @@ query
            ORDER BY rank DESC
            LIMIT $4
        """, language, query, workspace_id, limit)
        return [row_to_node(r) for r in rows]
```

**Asynchronous Vector Updates (for large datasets):**

```sql
-- For very large datasets, consider async updates via background job
-- Option 1: Materialized view (refreshed periodically)
CREATE MATERIALIZED VIEW node_search_mv AS
SELECT 
    id,
    workspace_id,
    to_tsvector(
        COALESCE(search_language, 'english')::regconfig,
        COALESCE(name, '')
    ) AS search_vector
FROM node
WHERE active = TRUE;

CREATE INDEX idx_node_search_mv ON node_search_mv USING GIN (search_vector);

-- Refresh periodically (e.g., every 5 minutes via pg_cron)
-- REFRESH MATERIALIZED VIEW CONCURRENTLY node_search_mv;

-- Option 2: Queue-based async updates
CREATE TABLE search_reindex_queue (
    id SERIAL PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(node_id)  -- Deduplicate
);

-- Trigger to queue reindex on update
CREATE OR REPLACE FUNCTION queue_search_reindex()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO search_reindex_queue (node_id)
    VALUES (NEW.id)
    ON CONFLICT (node_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### 7.3 Optimistic Locking

**Every write operation MUST increment the version:**

```sql
-- Example update with version check
UPDATE node 
SET name = $1, version = version + 1, write_date = NOW()
WHERE id = $2 AND version = $3
RETURNING *;
```

**Repository Implementation:**

```python
from ..errors import OptimisticLockError

class PostgresNodeRepository(NodeRepository):
    
    async def update(
        self, 
        node_id: int, 
        data: NodeUpdateData, 
        user_id: Optional[int] = None,
        expected_version: Optional[int] = None
    ) -> Optional[Node]:
        """Update a node with optimistic locking.
        
        Args:
            node_id: Node to update
            data: Update data
            user_id: User making the change
            expected_version: If provided, update only if version matches
            
        Raises:
            OptimisticLockError: If version doesn't match (concurrent edit)
        """
        # Build update query
        set_clauses = ["version = version + 1", "write_date = NOW()"]
        params = []
        param_idx = 1
        
        if data.name is not None:
            set_clauses.append(f"name = ${param_idx}")
            params.append(data.name)
            param_idx += 1
        
        # ... other fields ...
        
        # Add user tracking
        set_clauses.append(f"write_uid = ${param_idx}")
        params.append(user_id)
        param_idx += 1
        
        # Build WHERE clause with version check
        where_clause = f"id = ${param_idx}"
        params.append(node_id)
        param_idx += 1
        
        if expected_version is not None:
            where_clause += f" AND version = ${param_idx}"
            params.append(expected_version)
        
        query = f"""
            UPDATE node 
            SET {', '.join(set_clauses)}
            WHERE {where_clause}
            RETURNING *
        """
        
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(query, *params)
            
            if row is None and expected_version is not None:
                # Check if node exists but version mismatched
                exists = await conn.fetchval(
                    "SELECT version FROM node WHERE id = $1",
                    node_id
                )
                if exists is not None:
                    raise OptimisticLockError(
                        node_id=node_id,
                        expected_version=expected_version,
                        actual_version=exists,
                        message="Node was modified by another user"
                    )
            
            return self._row_to_node(row) if row else None
```

**Conflict Resolution Strategy:**

```python
# app/domain/errors.py
@dataclass
class OptimisticLockError(Exception):
    """Raised when a concurrent modification is detected."""
    node_id: int
    expected_version: int
    actual_version: int
    message: str = "Concurrent modification detected"


# Conflict resolution options:
class ConflictResolution(Enum):
    REJECT = "reject"           # Return error to client (default)
    LAST_WRITE_WINS = "lww"     # Overwrite anyway
    MERGE = "merge"             # Attempt field-level merge


async def handle_conflict(
    node_id: int,
    client_data: NodeUpdateData,
    resolution: ConflictResolution = ConflictResolution.REJECT
) -> Node:
    """Handle optimistic lock conflict based on strategy."""
    if resolution == ConflictResolution.REJECT:
        # Client must refresh and retry
        raise HTTPException(
            status_code=409,
            detail={
                "error": "conflict",
                "node_id": node_id,
                "message": "Node was modified. Please refresh and try again."
            }
        )
    
    elif resolution == ConflictResolution.LAST_WRITE_WINS:
        # Force update without version check
        return await repo.update(node_id, client_data, expected_version=None)
    
    elif resolution == ConflictResolution.MERGE:
        # Field-level merge (complex, use with caution)
        current = await repo.get_by_id(node_id)
        merged = merge_node_changes(current, client_data)
        return await repo.update(node_id, merged, expected_version=None)
```

**API Response for Conflicts:**

```python
# HTTP 409 Conflict response
{
    "error": "conflict",
    "node_id": 123,
    "expected_version": 5,
    "actual_version": 6,
    "message": "Node was modified by another user",
    "current_data": { ... }  # Optionally include current state
}
```

---

## 8. Multi-User and Node-Sharing Architecture

### 8.1 Workspace Model

```
┌─────────────────────────────────────────────────┐
│                   Workspace                      │
│  ┌─────────────┐  ┌─────────────┐               │
│  │   User A    │  │   User B    │               │
│  │   (owner)   │  │  (editor)   │               │
│  └──────┬──────┘  └──────┬──────┘               │
│         │                │                       │
│         ▼                ▼                       │
│  ┌──────────────────────────────────────┐       │
│  │              Nodes                    │       │
│  │  ┌─────┐  ┌─────┐  ┌─────┐          │       │
│  │  │Page │──│Block│──│Block│          │       │
│  │  └─────┘  └─────┘  └─────┘          │       │
│  └──────────────────────────────────────┘       │
└─────────────────────────────────────────────────┘
```

### 8.2 Permission Model

```python
class WorkspaceRole(Enum):
    OWNER = "owner"     # Full control, can delete workspace
    EDITOR = "editor"   # Can create/edit/delete nodes
    VIEWER = "viewer"   # Read-only access

class PermissionService:
    async def check_permission(
        self, 
        user_id: int, 
        workspace_id: int, 
        required_role: WorkspaceRole
    ) -> bool:
        # Query workspace_member table
        pass
    
    async def can_edit_node(
        self, 
        user_id: int, 
        node_id: int
    ) -> bool:
        # Get node's workspace, check membership
        pass
```

### 8.3 Real-Time Collaboration (Future)

For future real-time collaboration, consider:

1. **WebSocket connections** for live updates
2. **Operational Transformation (OT)** or **CRDTs** for conflict resolution
3. **Redis** for presence and cursors
4. **Event sourcing** for audit trail

### 8.4 Node Sharing Flow

```
1. User A creates workspace "Team Notes"
2. User A invites User B as editor
3. User B accepts → workspace_member record created
4. Both users can now edit nodes in workspace
5. Activity logged with user_id attribution
6. Conflicts handled via optimistic locking
```

---

## 9. Implementation Roadmap

### 9.1 Timeline Overview

| Phase | Duration | Focus |
|-------|----------|-------|
| Phase 1 | 2 weeks | Infrastructure & Schema |
| Phase 2 | 4 weeks | Repository Implementation |
| Phase 3 | 2 weeks | Data Migration |
| Phase 4 | 4 weeks | Multi-User Features |
| **Total** | **12 weeks** | |

### 9.2 Detailed Tasks

#### Phase 1: Infrastructure (Week 1-2)

- [ ] Add PostgreSQL to Docker Compose
- [ ] Create `postgres_schema.py` with full DDL
- [ ] Add `asyncpg` to requirements
- [ ] Implement connection pool manager
- [ ] Create database initialization scripts
- [ ] Update environment configuration

#### Phase 2: Repository Implementation (Week 3-6)

- [ ] Implement `PostgresNodeRepository`
- [ ] Implement `PostgresPropertyRepository`
- [ ] Implement `PostgresLinkRepository`
- [ ] Implement `PostgresUserRepository`
- [ ] Add repository factory pattern
- [ ] Update dependency injection
- [ ] Write unit tests for all repositories
- [ ] Integration tests with both databases

#### Phase 3: Data Migration (Week 7-8)

- [ ] Create migration script
- [ ] Implement ID mapping system
- [ ] Add validation and verification
- [ ] Test with sample user data
- [ ] Create rollback procedure
- [ ] Document migration process

#### Phase 4: Multi-User Features (Week 9-12)

- [ ] Implement workspace model
- [ ] Add permission service
- [ ] Update all services with workspace context
- [ ] Create workspace API endpoints
- [ ] Implement invitation system
- [ ] Add activity attribution
- [ ] Update frontend for workspace selection

### 9.3 Success Criteria

1. All existing tests pass against PostgreSQL
2. Data migration completes with 100% accuracy
3. Performance metrics meet or exceed SQLite
4. Multi-user editing works without conflicts
5. Rollback procedure tested and documented

---

## 10. Dev Environment and Docker Changes

### 10.1 Updated `compose.dev.yaml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: notees-postgres-dev
    environment:
      POSTGRES_USER: notees
      POSTGRES_PASSWORD: change_me_dev_password
      POSTGRES_DB: notees
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U notees"]
      interval: 5s
      timeout: 5s
      retries: 5

  backend:
    build:
      context: .
      dockerfile: Dockerfile.dev
    container_name: notees-backend-dev
    ports:
      - "${PORT:-8000}:8000"
    volumes:
      - ./app:/app/app:ro
      - ./data:/app/data
      - ./logs:/app/logs
    env_file:
      - .env
    environment:
      - RELOAD=true
      - DATABASE_URL=postgresql://notees:change_me_dev_password@postgres:5432/notees
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  frontend:
    image: node:20-alpine
    container_name: notees-frontend-dev
    working_dir: /app
    ports:
      - "5173:5173"
    volumes:
      - ./frontend:/app
      - /app/node_modules
    command: sh -c "npm install && npm run dev -- --host 0.0.0.0"
    depends_on:
      - backend

volumes:
  postgres_data:
```

### 10.2 Updated `requirements.txt`

```
# Core
fastapi==0.109.0
uvicorn[standard]==0.27.0
python-multipart==0.0.6
pydantic==2.5.3
pydantic-settings==2.1.0
Jinja2==3.1.2
python-jose[cryptography]==3.3.0
passlib[bcrypt]==1.7.4
python-dotenv==1.0.0

# Database - SQLite (keep for migration)
aiosqlite==0.19.0

# Database - PostgreSQL (new)
asyncpg==0.29.0
# Optional: SQLAlchemy for migrations
# sqlalchemy[asyncio]==2.0.25
# alembic==1.13.1

# Testing
pytest==7.4.4
pytest-asyncio==0.23.3
httpx==0.26.0
```

### 10.3 Updated `run_dev.py`

Add PostgreSQL health check before starting backend:

```python
def check_postgres():
    """Check if PostgreSQL is ready."""
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex(('localhost', 5432))
        sock.close()
        return result == 0
    except:
        return False

def check_prerequisites():
    errors = []
    # ... existing checks ...
    
    # Add PostgreSQL check if configured
    if os.getenv('DATABASE_URL', '').startswith('postgresql'):
        if not check_postgres():
            errors.append("PostgreSQL not available on port 5432")
    
    return errors
```

### 10.4 Environment Configuration

Add to `.env`:

```bash
# Database selection (feature flag for gradual rollout)
DATABASE_TYPE=postgres  # or "sqlite" for legacy
ENABLE_POSTGRES=true    # Feature flag for staging/rollback

# PostgreSQL configuration
DATABASE_URL=postgresql://notees:change_me_dev_password@localhost:5432/notees
POSTGRES_POOL_MIN=5
POSTGRES_POOL_MAX=20
POSTGRES_POOL_MAX_INACTIVE_TIME=300  # seconds
POSTGRES_STATEMENT_CACHE_SIZE=100

# SQLite configuration (legacy, for migration)
SQLITE_DATA_DIR=./data

# Monitoring
ENABLE_SLOW_QUERY_LOG=true
SLOW_QUERY_THRESHOLD_MS=100
```

### 10.6 Connection Pool Management

Proper connection pool configuration is critical for PostgreSQL performance:

```python
# app/db/postgres_connection.py
import asyncpg
import os
from contextlib import asynccontextmanager
from typing import Optional

from ..logging_config import get_logger

logger = get_logger(__name__)

_pool: Optional[asyncpg.Pool] = None


async def init_pool() -> asyncpg.Pool:
    """Initialize the connection pool on app startup."""
    global _pool
    
    if _pool is not None:
        return _pool
    
    _pool = await asyncpg.create_pool(
        dsn=os.getenv('DATABASE_URL'),
        min_size=int(os.getenv('POSTGRES_POOL_MIN', 5)),
        max_size=int(os.getenv('POSTGRES_POOL_MAX', 20)),
        max_inactive_connection_lifetime=float(
            os.getenv('POSTGRES_POOL_MAX_INACTIVE_TIME', 300)
        ),
        statement_cache_size=int(
            os.getenv('POSTGRES_STATEMENT_CACHE_SIZE', 100)
        ),
        command_timeout=60,
    )
    
    logger.info(
        f"PostgreSQL pool initialized: min={_pool.get_min_size()}, "
        f"max={_pool.get_max_size()}"
    )
    return _pool


async def close_pool() -> None:
    """Close the connection pool on app shutdown."""
    global _pool
    
    if _pool is not None:
        await _pool.close()
        logger.info("PostgreSQL pool closed")
        _pool = None


@asynccontextmanager
async def get_connection():
    """Get a connection from the pool with automatic release."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        yield conn


def get_pool_stats() -> dict:
    """Get current pool statistics for monitoring."""
    if _pool is None:
        return {"status": "not_initialized"}
    
    return {
        "status": "active",
        "size": _pool.get_size(),
        "min_size": _pool.get_min_size(),
        "max_size": _pool.get_max_size(),
        "free_size": _pool.get_idle_size(),
    }
```

**FastAPI Lifespan Integration:**

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI

from .db.postgres_connection import init_pool, close_pool


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    if os.getenv('DATABASE_TYPE') == 'postgres':
        await init_pool()
    yield
    # Shutdown
    if os.getenv('DATABASE_TYPE') == 'postgres':
        await close_pool()


app = FastAPI(lifespan=lifespan)
```

### 10.5 Updated `Dockerfile`

```dockerfile
FROM python:3.12-slim AS production

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

# Install system dependencies including PostgreSQL client
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

RUN mkdir -p /app/data /app/logs

RUN adduser --disabled-password --gecos '' appuser && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/auth/status')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## Appendix A: Performance Considerations

### A.1 Prepared Statements

For frequently executed queries, use prepared statements:

```python
# Using asyncpg prepared statements
class PostgresNodeRepository:
    _prepared_statements: Dict[str, asyncpg.PreparedStatement] = {}
    
    async def _prepare_statements(self, conn: asyncpg.Connection):
        """Prepare commonly used statements for performance."""
        if not self._prepared_statements:
            self._prepared_statements['get_by_id'] = await conn.prepare(
                "SELECT * FROM node WHERE id = $1"
            )
            self._prepared_statements['get_children'] = await conn.prepare(
                "SELECT * FROM node WHERE parent_id = $1 ORDER BY sequence"
            )
            self._prepared_statements['get_backlinks'] = await conn.prepare("""
                SELECT nl.*, n.name as source_name, n.is_page
                FROM node_link nl
                JOIN node n ON nl.source_node_id = n.id
                WHERE nl.target_node_id = $1
            """)
    
    async def get_by_id(self, node_id: int) -> Optional[Node]:
        async with self._pool.acquire() as conn:
            await self._prepare_statements(conn)
            row = await self._prepared_statements['get_by_id'].fetchrow(node_id)
            return self._row_to_node(row) if row else None
```

### A.2 Bulk Operations

For inserting many records (e.g., link parsing), use `copy_records_to_table`:

```python
async def bulk_create_links(self, links: List[NodeLink]) -> int:
    """Bulk insert links using COPY for best performance."""
    if not links:
        return 0
    
    records = [
        (
            link.source_node_id,
            link.target_node_id,
            link.position,
            link.property_id,
            link.is_tag,
            link.created_at
        )
        for link in links
    ]
    
    async with self._pool.acquire() as conn:
        await conn.copy_records_to_table(
            'node_link',
            records=records,
            columns=[
                'source_node_id', 'target_node_id', 'position',
                'property_id', 'is_tag', 'created_at'
            ]
        )
    
    return len(records)
```

### A.3 Query Optimization for Large Graphs

```sql
-- For pages with many backlinks, consider pagination
SELECT nl.*, n.name, n.is_page, n.page_id
FROM node_link nl
JOIN node n ON nl.source_node_id = n.id
WHERE nl.target_node_id = $1
ORDER BY nl.created_at DESC
LIMIT $2 OFFSET $3;

-- For graph visualization, limit depth
WITH RECURSIVE graph AS (
    SELECT id, parent_id, name, 0 as depth
    FROM node WHERE id = $1
    UNION ALL
    SELECT n.id, n.parent_id, n.name, g.depth + 1
    FROM node n
    JOIN graph g ON n.parent_id = g.id
    WHERE g.depth < $2  -- Max depth parameter
)
SELECT * FROM graph;

-- Analyze slow queries
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT ... your query ...;
```

---

## Appendix B: Query Migration Examples

### A.1 Node Creation

**SQLite:**
```python
cursor = await self._conn.execute("""
    INSERT INTO node (uuid, name, is_page, create_date, write_date)
    VALUES (?, ?, ?, ?, ?)
""", (uuid, name, int(is_page), now, now))
node_id = cursor.lastrowid
```

**PostgreSQL:**
```python
row = await self._conn.fetchrow("""
    INSERT INTO node (uuid, name, is_page, create_date, write_date)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
""", uuid, name, is_page, now, now)
node_id = row['id']
```

### A.2 Recursive Hierarchy Query

**SQLite (Python loop):**
```python
while current_id:
    cursor = await self._conn.execute(
        "SELECT id, is_page, parent_id FROM node WHERE id = ?",
        (current_id,)
    )
    row = await cursor.fetchone()
    if row['is_page']:
        return current_id
    current_id = row['parent_id']
```

**PostgreSQL (single query):**
```python
row = await self._conn.fetchrow("""
    WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, is_page
        FROM node WHERE id = $1
        UNION ALL
        SELECT n.id, n.parent_id, n.is_page
        FROM node n
        JOIN ancestors a ON n.id = a.parent_id
    )
    SELECT id FROM ancestors WHERE is_page = TRUE LIMIT 1
""", node_id)
```

### A.3 Bulk Insert with Conflict Handling

**SQLite:**
```python
await self._conn.execute("""
    INSERT OR IGNORE INTO node_property (node_id, property_id, create_date, write_date)
    VALUES (?, ?, ?, ?)
""", (node_id, property_id, now, now))
```

**PostgreSQL:**
```python
await self._conn.execute("""
    INSERT INTO node_property (node_id, property_id, create_date, write_date)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (node_id, property_id) DO NOTHING
""", node_id, property_id, now, now)
```

---

## Appendix B: Estimated Effort by Component

| Component | Files | Lines | Effort (days) |
|-----------|-------|-------|---------------|
| Schema | 1 | ~400 | 3 |
| Connection | 1 | ~200 | 2 |
| NodeRepository | 1 | ~600 | 5 |
| PropertyRepository | 1 | ~1200 | 8 |
| LinkRepository | 1 | ~250 | 3 |
| UserRepository | 1 | ~150 | 2 |
| Migration Script | 1 | ~500 | 5 |
| Docker/DevOps | 4 | ~200 | 3 |
| Tests | 5+ | ~500 | 5 |
| Multi-user Features | 5+ | ~1000 | 10 |
| **Total** | | | **~46 days** |

---

## Appendix C: Monitoring and Observability

### C.1 Connection Pool Monitoring

```python
# app/routers/health.py
from fastapi import APIRouter
from ..db.postgres_connection import get_pool_stats

router = APIRouter(prefix="/api/health", tags=["Health"])

@router.get("/db")
async def database_health():
    """Database health and pool statistics."""
    stats = get_pool_stats()
    
    return {
        "status": "healthy" if stats.get("status") == "active" else "degraded",
        "pool": stats,
        "checks": {
            "can_connect": await check_db_connection(),
            "response_time_ms": await measure_query_time(),
        }
    }
```

### C.2 Slow Query Logging

```python
# app/db/monitoring.py
import time
from functools import wraps
from ..logging_config import get_logger

logger = get_logger(__name__)
SLOW_QUERY_THRESHOLD_MS = float(os.getenv('SLOW_QUERY_THRESHOLD_MS', 100))

def log_slow_query(query: str, duration_ms: float, params: tuple = None):
    """Log queries that exceed the threshold."""
    if duration_ms > SLOW_QUERY_THRESHOLD_MS:
        logger.warning(
            f"Slow query ({duration_ms:.2f}ms): {query[:200]}...",
            extra={
                "query": query,
                "duration_ms": duration_ms,
                "params": str(params)[:100] if params else None
            }
        )


class MonitoredConnection:
    """Wrapper that logs slow queries."""
    
    def __init__(self, conn: asyncpg.Connection):
        self._conn = conn
    
    async def fetch(self, query: str, *args):
        start = time.monotonic()
        try:
            return await self._conn.fetch(query, *args)
        finally:
            elapsed_ms = (time.monotonic() - start) * 1000
            log_slow_query(query, elapsed_ms, args)
    
    # ... wrap other methods similarly
```

### C.3 Metrics to Track

| Metric | Description | Alert Threshold |
|--------|-------------|----------------|
| `db_pool_size` | Current pool size | N/A |
| `db_pool_free` | Available connections | < 2 |
| `db_pool_waiting` | Queries waiting for conn | > 5 |
| `db_query_duration_p99` | 99th percentile query time | > 500ms |
| `db_slow_queries_per_min` | Slow query count | > 10 |
| `migration_status` | Users pending migration | > 0 (after cutover) |

---

## Appendix D: Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Data loss during migration | Low | Critical | Backups, parallel run, checksum validation |
| Performance regression | Medium | High | Profiling, indexes, prepared statements |
| Concurrency bugs | Medium | High | Optimistic locking, comprehensive tests |
| API compatibility break | Low | Medium | Versioned API, feature flags |
| Extended downtime | Low | High | Rolling deployment, dual-write period |
| Partial migration failure | Medium | High | Resume-capable migration, status tracking |
| Connection pool exhaustion | Low | High | Monitoring, auto-scaling, queue limits |
| Schema migration conflicts | Low | Medium | Version tracking in schema_meta |

---

## Appendix E: Frontend/API Considerations

### E.1 Workspace UI

The frontend must clearly distinguish:

1. **Personal vs Shared workspaces** - Visual indicator (icon, badge)
2. **Permission level** - Show "View Only" badge for viewers
3. **Real-time presence** - Show who else is viewing/editing (future)
4. **Conflict indicators** - Highlight nodes with pending conflicts

```typescript
// frontend/src/types/workspace.ts
export interface Workspace {
  id: number;
  uuid: string;
  name: string;
  isShared: boolean;
  role: 'owner' | 'editor' | 'viewer';
  memberCount: number;
}

export interface WorkspaceContext {
  current: Workspace | null;
  available: Workspace[];
  switchWorkspace: (id: number) => Promise<void>;
}

// Visual indicators in UI
// - Personal workspace: user icon
// - Shared workspace: users icon with member count badge
// - Viewer role: eye icon + "View Only" tooltip
```

### E.2 API Access Control

```python
# All node endpoints must filter by workspace
@router.get("/nodes")
async def list_nodes(
    workspace_id: int = Query(...),
    current_user: User = Depends(get_current_user)
):
    # Verify user has access to workspace
    await permission_service.check_workspace_access(
        user_id=current_user.id,
        workspace_id=workspace_id
    )
    
    # Filter nodes by workspace
    return await node_service.get_nodes(workspace_id=workspace_id)


@router.put("/nodes/{node_id}")
async def update_node(
    node_id: int,
    data: NodeUpdateRequest,
    current_user: User = Depends(get_current_user)
):
    # Verify edit permission (not just view)
    await permission_service.check_node_edit(
        user_id=current_user.id,
        node_id=node_id
    )
    
    return await node_service.update(
        node_id=node_id,
        data=data,
        user_id=current_user.id,
        expected_version=data.version  # For optimistic locking
    )
```

### E.3 Conflict Resolution UI

```typescript
// Handle 409 Conflict response
interface ConflictResponse {
  error: 'conflict';
  node_id: number;
  expected_version: number;
  actual_version: number;
  message: string;
  current_data?: NodeResponse;
}

async function handleNodeUpdate(nodeId: number, data: NodeUpdateData) {
  try {
    return await api.updateNode(nodeId, data);
  } catch (error) {
    if (error.status === 409) {
      const conflict = error.data as ConflictResponse;
      
      // Show conflict dialog
      const resolution = await showConflictDialog({
        yourChanges: data,
        serverVersion: conflict.current_data,
        message: conflict.message
      });
      
      if (resolution === 'overwrite') {
        // Retry without version check
        return await api.updateNode(nodeId, { ...data, version: null });
      } else if (resolution === 'refresh') {
        // Reload and let user re-apply changes
        await refreshNode(nodeId);
      }
    }
    throw error;
  }
}
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-22 | AI Analysis | Initial comprehensive analysis |
| 1.1 | 2026-01-22 | AI Analysis | Added: connection pooling code examples, batched migration with FK validation, migration status tracking, detailed optimistic locking with conflict resolution, composite indexes, multi-language FTS, async vector updates, migration/concurrency tests, export format versioning, performance optimizations (prepared statements, bulk ops), monitoring/observability, frontend/API considerations |

---

*This document should be reviewed by the engineering team before implementation begins. Estimates are preliminary and may need adjustment based on team velocity and unforeseen challenges.*
