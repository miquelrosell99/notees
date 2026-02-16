# REST API Reference

All API endpoints are served under `/api/` and require JWT authentication unless noted otherwise. The API uses JSON request/response bodies.

---

## Authentication

### Register a New User

```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "alice",
  "password": "securepassword123"
}
```

**Response** (201):
```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "user": {
    "id": 1,
    "username": "alice",
    "created_at": "2026-02-16T10:00:00Z"
  }
}
```

> **Rate limit**: 3 requests/minute

### Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "alice",
  "password": "securepassword123"
}
```

**Response** (200): Same as register.

> **Rate limit**: 5 requests/minute

### Get Current User

```http
GET /api/auth/me
Authorization: Bearer {token}
```

**Response** (200):
```json
{
  "id": 1,
  "username": "alice",
  "created_at": "2026-02-16T10:00:00Z"
}
```

---

## Nodes

### Create Node

```http
POST /api/nodes/
Authorization: Bearer {token}

{
  "name": "My Page",
  "icon": "📄",
  "color": "#4A90D9",
  "parent_id": null,
  "sequence": 0,
  "classes": [42],
  "properties": {
    "15": "high priority"
  }
}
```

**Response** (201): Full `NodeResponse` object.

### Get Node by ID

```http
GET /api/nodes/{node_id}?include_children=true&include_backlinks=true&include_properties=true
Authorization: Bearer {token}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `include_children` | bool | `false` | Include full descendant tree |
| `include_backlinks` | bool | `false` | Include backlink data |
| `include_properties` | bool | `false` | Include property values |

### Get Node by UUID

```http
GET /api/nodes/uuid/{uuid}
Authorization: Bearer {token}
```

### Get Page Content

Returns the full page with all blocks, properties, backlinks, tags, and aliases in a single response.

```http
GET /api/nodes/page/{page_id}/content
Authorization: Bearer {token}
```

**Response** (200):
```json
{
  "id": 100,
  "uuid": "abc-123",
  "name": "My Page",
  "is_page": true,
  "children": [
    {
      "id": 101,
      "name": "{\"root\":{...}}",
      "parent_id": 100,
      "sequence": 0,
      "children": [...]
    }
  ],
  "properties": { ... },
  "backlinks": [ ... ],
  "tags": [5, 12],
  "classes": [42],
  "aliases": [201]
}
```

### Update Node

```http
PUT /api/nodes/{node_id}
Authorization: Bearer {token}

{
  "name": "Updated Title",
  "icon": "🎯",
  "expected_version": 3
}
```

Returns `409 Conflict` if `expected_version` doesn't match the current version (optimistic locking).

### Move Node

```http
PUT /api/nodes/{node_id}/move
Authorization: Bearer {token}

{
  "parent_id": 50,
  "position": 2
}
```

Handles indent/outdent/drag-drop. Validates against circular references and max hierarchy depth (100).

### Delete Node (Soft Delete)

```http
DELETE /api/nodes/{node_id}
Authorization: Bearer {token}
```

Moves to trash. Replaces all backlinks in other nodes with plain text.

### Permanently Delete

```http
DELETE /api/nodes/{node_id}/permanent
Authorization: Bearer {token}
```

Only works on already-trashed nodes. Hard deletes from database.

### Restore from Trash

```http
POST /api/nodes/{node_id}/restore
Authorization: Bearer {token}
```

### Archive / Unarchive

```http
POST /api/nodes/{node_id}/archive
POST /api/nodes/{node_id}/unarchive
Authorization: Bearer {token}
```

### Mark Page Opened (Recents)

```http
PATCH /api/nodes/{node_id}/open
Authorization: Bearer {token}
```

Updates `open_date` for recents tracking.

### Batch Operations

```http
# Batch Create
POST /api/nodes/batch
{ "nodes": [{ "name": "Page 1", "uuid": "custom-uuid" }, ...] }

# Batch Update
PUT /api/nodes/batch
{ "nodes": [{ "id": 42, "name": "New Name" }, { "uuid": "abc", "color": "#FF0000" }] }

# Batch Soft Delete
DELETE /api/nodes/batch
{ "uuids": ["uuid-1", "uuid-2"] }

# Batch Permanent Delete (from trash)
POST /api/nodes/trash/batch-delete
{ "ids": [42, 43, 44] }
```

### List / Filter Nodes

```http
GET /api/nodes/?pages_only=true&root_only=true&page=1&page_size=50
Authorization: Bearer {token}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pages_only` | bool | `false` | Only return pages |
| `parent_id` | int | — | Filter by parent |
| `type_id` | int | — | Filter by type |
| `class_filters` | string | — | Comma-separated class IDs |
| `include_children` | bool | `false` | Include children tree |
| `root_only` | bool | `false` | Only root-level pages |
| `page` | int | `1` | Page number (≥1) |
| `page_size` | int | `50` | Items per page (1–200) |

**Response** (paginated):
```json
{
  "items": [ ... ],
  "total": 150,
  "page": 1,
  "page_size": 50,
  "has_next": true,
  "has_prev": false
}
```

### Search Nodes

```http
GET /api/nodes/search?q=machine+learning&limit=25&class_filters=42,43
Authorization: Bearer {token}
```

### Recent / Archived / Trash

```http
GET /api/nodes/recents          # Recent pages by open_date DESC
GET /api/nodes/archived          # All archived pages
GET /api/nodes/trash             # All trashed nodes
POST /api/nodes/trash/empty      # Permanently delete ALL trash
```

---

## Daily Journal

### Get or Create Daily Page

```http
POST /api/nodes/daily?date=2026-02-16
Authorization: Bearer {token}
```

Auto-creates the hierarchy: Year (`2026`) → Month (`February 2026`) → Day (`February 16, 2026`).

### Get or Create Monthly / Yearly Pages

```http
POST /api/nodes/monthly?year=2026&month=2
POST /api/nodes/yearly?year=2026
Authorization: Bearer {token}
```

### List All Daily Pages

```http
GET /api/nodes/daily/list
Authorization: Bearer {token}
```

Returns all daily pages ordered by UUID (date) descending.

---

## Classes

### List All Classes

```http
GET /api/nodes/classes
Authorization: Bearer {token}
```

### Search Classes

```http
GET /api/nodes/classes/search?q=project&limit=10
Authorization: Bearer {token}
```

### Get Nodes with Class (including subclass inheritance)

```http
GET /api/nodes/classes/{class_id}/nodes
Authorization: Bearer {token}
```

### Add / Remove Class from Node

```http
POST /api/nodes/{node_id}/classes
{ "class_node_id": 42 }

DELETE /api/nodes/{node_id}/classes/{class_id}
Authorization: Bearer {token}
```

---

## Links & Backlinks

### Get Text Links

```http
GET /api/nodes/{node_id}/text-links
Authorization: Bearer {token}
```

### Add / Remove Tag Link

```http
POST /api/nodes/{node_id}/tag-links
{ "target_node_id": 50 }

DELETE /api/nodes/{node_id}/tag-links/{target_id}
Authorization: Bearer {token}
```

### Get Backlinks

```http
GET /api/nodes/{node_id}/backlinks?include_inherited=true
Authorization: Bearer {token}
```

### Get Linked References (with full tree context)

```http
GET /api/nodes/{node_id}/linked-references
Authorization: Bearer {token}
```

### Get Property Backlinks

```http
GET /api/nodes/{node_id}/property-backlinks
Authorization: Bearer {token}
```

### Update Link Display Name

```http
PATCH /api/nodes/link/name
{ "link_uuid": "link-uuid-123", "name": "Custom Label" }
Authorization: Bearer {token}
```

### Aliases

```http
GET /api/nodes/{node_id}/aliases
POST /api/nodes/{node_id}/aliases       { "alias_node_id": 201 }
DELETE /api/nodes/{node_id}/aliases/{alias_id}
Authorization: Bearer {token}
```

---

## Properties

### Create Property Definition

```http
POST /api/properties/

{
  "name": "Priority",
  "type": "selection",
  "is_multi": false,
  "class_filters": [42],
  "selection_lines": ["Low", "Medium", "High"]
}
```

**Property types**: `integer`, `float`, `boolean`, `text`, `node`, `date`, `image`, `selection`

### List Properties

```http
GET /api/properties/?include_local=true
Authorization: Bearer {token}
```

### Set Property Value (Unified)

```http
POST /api/nodes/{node_id}/properties

{
  "property_id": 15,
  "value": "high"
}
```

Auto-detects property type and dispatches to the appropriate handler (scalar/relation/selection).

### Type-Specific Value Endpoints

```http
# Scalar (integer, float, boolean)
POST   /api/nodes/{node_id}/properties/{property_id}/scalar   { "value": 42 }
GET    /api/nodes/{node_id}/properties/{property_id}/scalar
DELETE /api/nodes/{node_id}/properties/{property_id}/scalar/{value_id}
DELETE /api/nodes/{node_id}/properties/{property_id}/scalar    # Clear all

# Relation (node, text, image, date)
POST   /api/nodes/{node_id}/properties/{property_id}/relation  { "target_node_id": 100 }
GET    /api/nodes/{node_id}/properties/{property_id}/relation
DELETE /api/nodes/{node_id}/properties/{property_id}/relation/{value_id}
DELETE /api/nodes/{node_id}/properties/{property_id}/relation   # Clear all

# Selection
POST   /api/nodes/{node_id}/properties/{property_id}/selection { "selection_line_id": 5 }
GET    /api/nodes/{node_id}/properties/{property_id}/selection
DELETE /api/nodes/{node_id}/properties/{property_id}/selection/{value_id}
DELETE /api/nodes/{node_id}/properties/{property_id}/selection  # Clear all
```

### Batch Get Properties

```http
POST /api/nodes/batch/properties
{ "node_ids": [42, 43, 44] }
```

### Class-Property Bindings

```http
GET  /api/properties/classes/{class_id}/properties?include_inherited=true
POST /api/properties/classes/{class_id}/properties  { "property_id": 15 }
DELETE /api/properties/classes/{class_id}/properties/{property_id}
```

### Selection Line Options

```http
GET    /api/properties/{property_id}/selection-lines
POST   /api/properties/{property_id}/selection-lines        { "name": "Critical", "icon": "🔴" }
PUT    /api/properties/{property_id}/selection-lines/{id}   { "name": "Updated" }
DELETE /api/properties/{property_id}/selection-lines/{id}   # Only if unused
```

---

## Node Views (Dynamic Queries)

### List Views for a Node

```http
GET /api/nodes/views?node_id=100&view_type=child_pages&include_query_ast=true
Authorization: Bearer {token}
```

### Create View

```http
POST /api/nodes/views

{
  "node_id": 100,
  "name": "Active Projects",
  "view_type": "classed_nodes",
  "query_ast": { ... }
}
```

### Execute Query

```http
POST /api/nodes/views/{view_id}/execute

{
  "runtime_params": {
    "current_node_uuid": "abc-123",
    "current_node_id": 100
  },
  "limit": 50,
  "offset": 0,
  "enrich": {
    "children": true,
    "properties": true,
    "classes": true
  }
}
```

### Execute Ad-hoc Query (without saving)

```http
POST /api/nodes/views/execute

{
  "query_ast": {
    "version": "1.0",
    "scope": { "scope_type": "entire_workspace" },
    "root_group": {
      "logic": "and",
      "children": [
        { "type": "class", "class_uuid": "abc-123" }
      ]
    }
  },
  "limit": 100
}
```

---

## Assets

### Upload File

```http
POST /api/assets/upload
Content-Type: multipart/form-data
Authorization: Bearer {token}

file: (binary)
parent_id: 100  (optional)
```

**Supported**: JPEG, PNG, WebP (images); MP3, WAV, OGG, OPUS, WebM (audio). Max 50MB.

### Get Asset File

```http
GET /api/assets/{asset_uuid}?asset_token={short-lived-token}
```

### Get Asset Thumbnail

```http
GET /api/assets/{asset_uuid}/thumbnail?asset_token={token}
```

### Generate Access Token

```http
POST /api/assets/{asset_uuid}/token
Authorization: Bearer {token}
```

Returns a 5-minute JWT scoped to the specific asset.

---

## Workspaces

```http
GET    /api/workspaces                           # List all + active UUID
POST   /api/workspaces                           # Create { "name": "Work" }
POST   /api/workspaces/{id}/switch               # Switch active workspace
PUT    /api/workspaces/{name}/rename              # Rename { "name": "New Name" }
DELETE /api/workspaces/{name}                     # Delete workspace
GET    /api/workspaces/{name}/export              # Download workspace file
POST   /api/workspaces/import                     # Upload workspace file
GET    /api/workspaces/check-name/{name}          # Check name availability
```

---

## Settings

```http
GET /api/settings                    # All user settings
PUT /api/settings/{key}              # Set a setting
    { "value": "dark" }
```

Settings are per-user (not per-workspace). Values stored as JSONB.

---

## Activity & Link Tracking

```http
GET  /api/activity/node/{node_id}?limit=50            # Activity log
POST /api/activity/node/{node_id}                      # Create activity
POST /api/activity/link/click                          # Track link click
GET  /api/activity/link/clicks/{source_node_id}        # Aggregated clicks
POST /api/activity/link/reset/{source_id}/{target_id}  # Reset counter
```

**Activity actions**: `created`, `edited`, `link_added`, `link_removed`, `link_inserted`, `archived`, `unarchived`, `type_added`, `type_removed`, `property_changed`, `moved`

---

## Export

```http
POST /api/export
{ "node_ids": [42, 43], "format": "markdown", "include_children": true }

GET /api/export/{node_id}
```

**Formats**: `markdown`, `html`, `pdf`

---

## Comments

```http
GET    /api/nodes/{node_id}/comments                    # List comments
POST   /api/nodes/{node_id}/comments  { "name": "..." } # Create comment
DELETE /api/nodes/{node_id}/comments/{comment_id}        # Delete comment
GET    /api/nodes/{node_id}/comment-count                # Count only
```

---

## Favorites

```http
GET    /api/nodes/favorites                       # Get favorites list
PUT    /api/nodes/favorites  { "favorites": [...] }  # Set full list
PUT    /api/nodes/favorites/reorder               # Reorder
POST   /api/nodes/favorites/{node_id}             # Add to favorites
DELETE /api/nodes/favorites/{node_id}             # Remove from favorites
```

---

## Workspace Graph

```http
GET  /api/nodes/workspace/nodes                    # All workspace nodes
POST /api/nodes/links                              # Links for specific nodes
     { "node_ids": [1,2,3], "scope": "between" }
```

**Link types**: `reference`, `parent`, `class`, `extends`, `property-reference`

**Scope options**:
- `between`: Both endpoints must be in the provided set
- `touching`: At least one endpoint must be in the set
