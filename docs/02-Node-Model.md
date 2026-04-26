# The Node Model

The Node is the **fundamental building block** of Notees. Every piece of content — pages, blocks, classes, tags, daily journals, assets, templates, comments — is stored as a Node record, differentiated by flags and relationships.

---

## Node Entity

Defined in `app/domain/entities/node.py` as a Python dataclass.

### Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `int` | Auto-increment | Internal database primary key |
| `uuid` | `str` | Generated | Public identifier used in links and navigation |
| `workspace_id` | `int` | — | Workspace this node belongs to |
| `name` | `str` | `""` | Main content (stored as JSON AST for rich text) |
| `icon` | `str?` | `None` | Emoji icon displayed alongside the node |
| `color` | `str?` | `None` | Hex color for visual customization |

### Hierarchy Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parent_id` | `int?` | `None` | Parent node ID (`None` for root pages) |
| `page_id` | `int?` | `None` | Containing page ID (computed for blocks) |
| `sequence` | `int` | `0` | Order among siblings |
| `collapsed` | `bool` | `False` | Whether children are hidden in the UI |

### Classification Flags

| Field | Type | Description |
|-------|------|-------------|
| `is_page` | `bool` | Top-level page (navigable) |
| `is_class` | `bool` | Defines a type/class for categorization |
| `is_day` | `bool` | Daily journal page |
| `is_month` | `bool` | Monthly journal page |
| `is_year` | `bool` | Yearly journal page |
| `is_asset` | `bool` | File attachment (image, audio) |
| `is_template` | `bool` | Template node |
| `is_comment` | `bool` | Comment on another node |
| `parent_locked` | `bool` | Prevents parent_id from being changed |

### Lifecycle Fields

| Field | Type | Description |
|-------|------|-------------|
| `active` | `bool` | `false` = archived |
| `is_deleted` | `bool` | `true` = in trash (soft-deleted) |
| `deleted_at` | `str?` | ISO timestamp of when it was trashed |
| `version` | `int` | Optimistic locking counter (incremented on updates) |

### Class & Property Fields

| Field | Type | Description |
|-------|------|-------------|
| `class_ids` | `List[int]` | Direct class assignments on this node |
| `classes_path` | `List[int]` | Inherited class IDs from all ancestors |
| `aliased_id` | `int?` | If this node is an alias, points to the main node |

### Audit Fields

| Field | Type | Description |
|-------|------|-------------|
| `create_date` | `str` | ISO creation timestamp |
| `write_date` | `str` | ISO last-modified timestamp |
| `open_date` | `str?` | ISO timestamp of last time user opened this node |
| `create_uid` | `int?` | User who created this node |
| `write_uid` | `int?` | User who last modified this node |

---

## Node Types (by flag combinations)

Since everything is a Node, the type is determined by flags:

### Pages vs Blocks

```
┌─────────────────────────────────────────┐
│  Page (is_page=true, parent_id=null)    │
│  ├── Block (parent_id=page.id)          │
│  │   ├── Block (nested child)           │
│  │   └── Block (nested child)           │
│  ├── Block                              │
│  └── Block                              │
└─────────────────────────────────────────┘
```

- **Page**: `is_page=true`, `parent_id=null`. Navigable, appears in All Pages.
- **Block**: `parent_id` is set. Child of a page or another block. Forms an outliner-style tree.

```python
# Check if a node is a block
def is_block(self) -> bool:
    return self.parent_id is not None
```

### Classes (Types)

Nodes with `is_class=true` define categories that can be applied to other nodes:

```
Class: "Project" (is_class=true, is_page=true)
  → Applied to: "Build Website" (class_ids=[project_class_id])
  → Applied to: "Fix Bug #42"  (class_ids=[project_class_id])
```

### Daily Journals

Date pages are nodes with special flags and deterministic UUIDs:

| Flag | UUID Format | Example UUID | Example Name |
|------|------------|--------------|--------------|
| `is_year=true` | `00000000-0000-0000-00bb-YYYY00000000` | `00000000-0000-0000-00bb-202600000000` | `2026` |
| `is_month=true` | `00000000-0000-0000-00aa-YYYYMM000000` | `00000000-0000-0000-00aa-202602000000` | `February 2026` |
| `is_day=true` | `00000000-0000-0000-00dd-YYYYMMDD0000` | `00000000-0000-0000-00dd-202602160000` | `February 16, 2026` |

The hierarchy is always: Year → Month → Day (via `parent_id`).

### Assets

Nodes with `is_asset=true` represent uploaded files. Each asset node maps to a folder on disk:
```
data/workspaces/{workspace_uuid}/assets/{asset_uuid}/main.{ext}
```

### Comments

Nodes with `is_comment=true` are children of the commented node. They support nested replies (child comments).

---

## Creating Nodes

### NodeCreateData

Used when creating a new node:

```python
@dataclass
class NodeCreateData:
    name: str = ""                     # Content (JSON AST string)
    icon: Optional[str] = None         # Emoji icon
    color: Optional[str] = None        # Hex color
    parent_id: Optional[int] = None    # None = root page
    sequence: int = 0                  # Sibling order
    collapsed: bool = False
    classes: List[int] = field(default_factory=list)  # Class IDs to apply
    property_values: dict = field(default_factory=dict)  # Initial prop values
    uuid: Optional[str] = None         # Custom UUID (for imports)
```

### API Example: Create a Page

```http
POST /api/nodes/

{
  "name": "My New Page",
  "icon": "📝",
  "color": "#4A90D9",
  "classes": [42],
  "properties": {
    "15": "high"
  }
}
```

### API Example: Create a Block (child of a page)

```http
POST /api/nodes/

{
  "name": "{\"root\":{\"children\":[{\"type\":\"paragraph\",\"children\":[{\"text\":\"Hello world\"}]}]}}",
  "parent_id": 100,
  "sequence": 0
}
```

### Hierarchical Page Creation

Creating a page with a `/` in the name auto-creates intermediate pages:

```http
POST /api/nodes/

{
  "name": "Projects/Website/Homepage"
}
```

This creates three pages:
1. `Projects` (root page)
2. `Website` (child of Projects)
3. `Homepage` (child of Website) ← the returned node

---

## Updating Nodes

### NodeUpdateData

```python
@dataclass
class NodeUpdateData:
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    clear_icon: bool = False          # Explicitly remove icon
    clear_color: bool = False         # Explicitly remove color
    parent_id: Optional[int] = None
    sequence: Optional[int] = None
    collapsed: Optional[bool] = None
    classes: Optional[List[int]] = None
    property_values: Optional[dict] = None
```

### Optimistic Locking

Updates support optimistic locking via `expected_version`:

```http
PUT /api/nodes/42

{
  "name": "Updated Title",
  "expected_version": 3
}
```

If the node's version doesn't match, the API returns `409 Conflict`.

---

## Deleting Nodes

Notees uses a **two-stage deletion** process:

### Stage 1: Soft Delete (Trash)

```http
DELETE /api/nodes/42
```

- Sets `is_deleted=true`, records `deleted_at` timestamp
- **Replaces all backlinks** in other nodes with plain text (so references don't break)
- Removes inline class references that pointed to this node
- Removes property-value relations referencing this node
- Cascades to all descendant blocks
- Deletes associated asset files from disk

### Stage 2: Permanent Delete

```http
DELETE /api/nodes/42/permanent
```

- Only works on already-trashed nodes
- Hard-deletes the record from the database

### Restore from Trash

```http
POST /api/nodes/42/restore
```

- Sets `is_deleted=false`, clears `deleted_at`
- Note: Backlinks that were converted to plain text are **not** automatically restored

---

## Node Lifecycle Diagram

```
                    ┌─────────┐
          create    │  Active  │    update/move
         ────────►  │ (normal) │  ◄──────────
                    └────┬────┘
                         │
              archive    │    soft-delete
             ┌───────────┼───────────┐
             ▼           │           ▼
        ┌─────────┐      │     ┌──────────┐
        │Archived │      │     │  Trash   │
        │(active= │      │     │(is_deleted│
        │ false)  │      │     │ = true)  │
        └────┬────┘      │     └────┬─────┘
             │           │          │
          unarchive      │    restore / permanent delete
             └───────────┘          │
                                    ▼
                              ┌───────────┐
                              │  Deleted   │
                              │(hard, gone)│
                              └───────────┘
```

---

## Batch Operations

For imports and bulk edits, batch endpoints process items independently — one failure doesn't block others:

### Batch Create

```http
POST /api/nodes/batch

{
  "nodes": [
    { "name": "Page 1", "uuid": "custom-uuid-1" },
    { "name": "Page 2", "parent_id": 100, "sequence": 0 },
    { "name": "Page 3", "classes": [42, 43] }
  ]
}
```

Response includes per-item results:
```json
{
  "created": 2,
  "failed": 1,
  "results": [
    { "index": 0, "success": true, "node": { "id": 201, ... } },
    { "index": 1, "success": true, "node": { "id": 202, ... } },
    { "index": 2, "success": false, "error": "Class 43 not found" }
  ]
}
```

### Batch Update / Batch Delete

```http
PUT /api/nodes/batch
{ "nodes": [{ "id": 42, "name": "New Name" }, { "uuid": "abc-123", "color": "#FF0000" }] }

DELETE /api/nodes/batch
{ "uuids": ["uuid-1", "uuid-2", "uuid-3"] }
```

---

## Frontend Node Interface

The TypeScript `Node` interface mirrors the backend model:

```typescript
interface Node {
  id: number;
  uuid: string;
  name: string;
  icon?: string;
  color?: string;
  parent_id?: number;
  page_id?: number;
  sequence: number;
  collapsed: boolean;
  active: boolean;
  is_page: boolean;
  is_class: boolean;
  is_day: boolean;
  is_month: boolean;
  is_year: boolean;
  is_asset: boolean;
  is_template: boolean;
  is_comment: boolean;
  parent_locked: boolean;
  is_deleted: boolean;
  deleted_at?: string;
  display_name?: string;
  tags: number[];
  classes: number[];
  classes_path: number[];
  properties: Record<string, any>;
  children?: Node[];
  backlinks?: any[];
  linked_references?: any[];
  backlink_count: number;
  comment_count: number;
  aliased_id?: number;
  aliases: number[];
  version: number;
  create_date: string;
  write_date: string;
  open_date?: string;
}
```

---

## Node Content Format

The `name` field stores content as a **JSON AST** (Abstract Syntax Tree) compatible with the Lexical editor:

```json
{
  "root": {
    "children": [
      {
        "type": "paragraph",
        "children": [
          { "text": "Hello " },
          { "type": "link", "target": "abc-uuid", "children": [{ "text": "world" }] },
          { "text": "!" }
        ]
      }
    ]
  }
}
```

Links within the content (`[[nodeUuid]]`) are parsed and stored as separate `NodeLink` entities for efficient backlink queries. See the [Links & Backlinks](06-Links-and-Backlinks.md) document for details.
