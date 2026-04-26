# Query System

The Query System powers all dynamic node collections in Notees — child pages, classed nodes, linked references, and custom queries. It uses a structured AST (Abstract Syntax Tree) that compiles to PostgreSQL SQL at runtime.

---

## Overview

```
QueryAST (JSON)  →  Validation  →  Optimization  →  SQL Generation  →  Execution
                                                                          ↓
                                                                     Node Results
```

Every section that shows a dynamic list of nodes (child pages, linked references, etc.) is backed by a QueryAST executed via the query engine.

---

## QueryAST Structure (v1.0)

The canonical query format, defined in `app/domain/entities/query_ast.py`:

```json
{
  "version": "1.0",
  "scope": {
    "scope_type": "entire_workspace",
    "include_descendants": false,
    "excluded_page_uuids": []
  },
  "root_group": {
    "logic": "and",
    "children": [
      { "type": "class", "class_uuid": "abc-123" },
      { "type": "property", "property_name": "status", "operator": "equals", "value": "active" }
    ]
  }
}
```

### Top-Level Structure

| Field | Type | Description |
|-------|------|-------------|
| `version` | `str` | Always `"1.0"` |
| `scope` | `ScopeNode` | What nodes to search within |
| `root_group` | `GroupNode` | The main filter logic tree |
| `id` | `str?` | Optional unique ID |
| `description` | `str?` | Human-readable description |
| `is_system` | `bool` | System queries are read-only |

---

## Scope

Controls the search breadth:

| Scope Type | Description | SQL Effect |
|------------|-------------|------------|
| `entire_workspace` | All nodes in the workspace | No additional filter |
| `pages` | Only page nodes | `is_page = TRUE` |
| `current_page` | Current node and its descendants | Uses `node_path` closure table |

```json
// Search only pages
{ "scope_type": "pages" }

// Search within current page hierarchy
{ "scope_type": "current_page", "include_descendants": true }
```

---

## Logic Groups

Groups combine conditions with logical operators:

```json
{
  "logic": "and",
  "children": [
    { "type": "class", "class_uuid": "project-uuid" },
    {
      "logic": "or",
      "children": [
        { "type": "property", "property_name": "status", "operator": "equals", "value": "active" },
        { "type": "property", "property_name": "status", "operator": "equals", "value": "draft" }
      ]
    }
  ]
}
```

### NOT Groups

Negate a single condition or group:

```json
{
  "type": "not",
  "child": {
    "type": "class",
    "class_uuid": "archived-uuid"
  }
}
```

---

## Condition Types

### Class Condition

Match nodes with a specific class:

```json
{
  "type": "class",
  "class_uuid": "project-uuid",
  "class_id": 42
}
```

Uses recursive CTE via `class_extend` table for inheritance — matches nodes with the class directly **or** any subclass.

### Extends Condition

Match classes that extend a specific parent class:

```json
{
  "type": "extends",
  "extends_class_uuid": "base-class-uuid"
}
```

### Property Condition

Filter by property values:

```json
{
  "type": "property",
  "property_name": "priority",
  "property_id": 15,
  "property_type": "SELECT",
  "operator": "equals",
  "value": "high"
}
```

**Property Operators:**

| Operator | Applicable Types | Description |
|----------|-----------------|-------------|
| `equals` | All | Exact match |
| `not_equals` | All | Not equal |
| `greater_than` | Number, Date | Greater than |
| `less_than` | Number, Date | Less than |
| `gte` | Number, Date | Greater or equal |
| `lte` | Number, Date | Less or equal |
| `contains` | Text | Substring match |
| `starts_with` | Text | Prefix match |
| `ends_with` | Text | Suffix match |
| `is_empty` | All | No value set |
| `is_not_empty` | All | Has any value |
| `in` | All | Value in list |
| `not_in` | All | Value not in list |

**Built-in property shortcuts**: Properties named `uuid`, `name`, or `id` query the Node columns directly instead of the property tables.

### Content Condition

Search within node content (the `name` field's JSON AST):

```json
{
  "type": "content",
  "operator": "contains",
  "value": "machine learning",
  "case_sensitive": false
}
```

**Content Operators:**

| Operator | Description |
|----------|-------------|
| `contains` | `ILIKE '%value%'` |
| `equals` | Exact text match |
| `starts_with` | `ILIKE 'value%'` |
| `ends_with` | `ILIKE '%value'` |
| `regex` | PostgreSQL `~*` regex |
| `fts` | Full-text search via `to_tsvector` |

Content extraction uses `jsonb_path_query` to extract plain text from the JSON AST.

### Style Condition

Filter by text formatting:

```json
{
  "type": "style",
  "style_type": "BOLD",
  "operator": "CONTAINS"
}
```

**Style types**: `BOLD`, `ITALIC`, `UNDERLINE`, `STRIKETHROUGH`
**Style operators**: `IS`, `IS_NOT`, `CONTAINS`, `DOES_NOT_CONTAIN`

Uses `jsonb_path_exists` to check formatting attributes in the AST.

### Reference Condition

Match nodes that reference (link to) a specific target:

```json
{
  "type": "reference",
  "target_uuid": "page-abc-uuid",
  "target_id": 100
}
```

Checks both `node_link` table (text links) and `property_value_relation` table (property references).

### Reference Path Condition

Match nodes that reference **any node matching a dynamic query**:

```json
{
  "type": "reference_path",
  "nested_group": {
    "logic": "and",
    "children": [
      { "type": "class", "class_uuid": "project-uuid" }
    ]
  }
}
```

Or with static targets:

```json
{
  "type": "reference_path",
  "target_uuids": ["uuid-1", "uuid-2"]
}
```

### Parent Condition

Match nodes with specific parent(s):

```json
// Static parent
{
  "type": "parent",
  "parent_uuid": "page-uuid"
}

// Dynamic: parent matches query
{
  "type": "parent",
  "nested_group": {
    "logic": "and",
    "children": [
      { "type": "class", "class_uuid": "project-uuid" }
    ]
  }
}
```

### Parent Path Condition

Match nodes whose **ancestor chain** (not just direct parent) matches criteria:

```json
{
  "type": "parent_path",
  "nested_group": {
    "logic": "and",
    "children": [
      { "type": "class", "class_uuid": "folder-uuid" }
    ]
  },
  "max_depth": 5
}
```

### Child / Child Path Conditions

Match nodes that **have children** matching criteria:

```json
// Has at least one child matching
{
  "type": "child",
  "nested_group": {
    "logic": "and",
    "children": [{ "type": "class", "class_uuid": "task-uuid" }]
  }
}

// Has descendants (at any depth) matching
{
  "type": "child_path",
  "nested_group": { ... },
  "max_depth": 10
}
```

### Flag Condition

Match nodes by boolean flags:

```json
{
  "type": "flag",
  "flag_name": "is_page",
  "value": true
}
```

Available flags: `is_page`, `is_class`, `is_day`, `is_month`, `is_year`, `is_asset`, `is_template`, `is_comment`, `collapsed`, `active`

---

## Runtime Placeholders

Queries can use placeholders that are resolved at execution time:

| Placeholder | Resolves To |
|-------------|-------------|
| `{current_node_uuid}` | UUID of the node the query is attached to |
| `{current_node_id}` | ID of the current node |
| `{current_user_id}` | ID of the authenticated user |
| `{current_node_name}` | Display name of the current node |
| `{today}` | Today's date UUID |

### Example: "Child Pages of Current Node"

```json
{
  "scope": { "scope_type": "pages" },
  "root_group": {
    "logic": "and",
    "children": [
      {
        "type": "parent",
        "parent_uuid": "{current_node_uuid}"
      }
    ]
  }
}
```

---

## Default System Views

Every node can have multiple **NodeView** records, each containing a query:

| View Type | Default Query Logic |
|-----------|-------------------|
| `child_pages` | Pages where parent = current node |
| `classed_nodes` | Nodes with class = current node (for class pages) |
| `extended_by` | Classes extending current node (for class pages) |
| `linked_references` | Nodes referencing current node |
| `unlinked_references` | Content contains current node's name but UUID doesn't match |
| `main_content` | Empty query (system view for block content) |

Default views are lazily created via `ensure_default_views(node_id)`.

---

## Node Views

A `NodeView` wraps a query with view configuration:

```python
@dataclass
class NodeView:
    id: int
    uuid: str
    node_id: int              # The node this view belongs to
    name: str                 # "Active Projects", "Recent Tasks"
    query_json: str           # JSON-serialized QueryAST
    view_type: str            # "child_pages", "classed_nodes", etc.
    order_index: int          # Tab order
    is_default: bool          # Whether this is the default view for its type
    active: bool              # Soft-delete flag
    shown_properties: List[Dict]  # Property columns for table view
    group_by: Optional[str]       # Group results by property
```

### Managing Views

```http
# List views for a node
GET /api/nodes/views?node_id=100&view_type=child_pages

# Create a custom view
POST /api/nodes/views
{
  "node_id": 100,
  "name": "High Priority Tasks",
  "view_type": "classed_nodes",
  "query_ast": { ... }
}

# Update query
PUT /api/nodes/views/{view_id}/query-ast
{ "query_ast": { ... } }

# Reorder views
POST /api/nodes/views/reorder/100/child_pages
{ "view_ids": [5, 3, 7] }

# Reset to defaults
POST /api/nodes/views/reset/100
```

---

## Query Execution

### Execute a View's Query

```http
POST /api/nodes/views/{view_id}/execute

{
  "runtime_params": {
    "current_node_uuid": "abc-123",
    "current_node_id": 100
  },
  "limit": 50,
  "offset": 0,
  "order_by": "sequence ASC",
  "enrich": {
    "children": true,
    "properties": true,
    "classes": true
  }
}
```

**Response:**

```json
{
  "nodes": [
    { "id": 42, "uuid": "...", "name": "...", "children": [...], "properties": {...} },
    { "id": 43, ... }
  ],
  "total_count": 150,
  "metrics": {
    "ast_nodes_before": 8,
    "ast_nodes_after": 5,
    "conditions_before": 3,
    "conditions_after": 2,
    "max_depth": 2,
    "sql_time_ms": 12.5,
    "total_time_ms": 18.3,
    "cache_hit": true,
    "has_recursive_cte": false,
    "has_path_queries": false,
    "has_property_joins": true,
    "has_content_search": false
  }
}
```

### Enrichment Options

| Option | Default | Description |
|--------|---------|-------------|
| `children` | `false` | Include full child block tree |
| `properties` | `false` | Include property values |
| `classes` | `true` | Include class IDs |

### Query Validation

```http
POST /api/nodes/views/validate-query-ast
{ "query_ast": { ... } }
```

**Validation rules:**
- System queries (`is_system=true`) are read-only
- Nesting > 5 levels triggers a warning
- Missing required fields (class_uuid, property_name, target_uuid) are errors
- Empty root groups produce a warning

---

## SQL Generation

The `QueryASTToSQL` compiler converts AST → PostgreSQL:

### Base Query

```sql
SELECT DISTINCT n.id, n.uuid, n.name, n.icon, n.color, ...
FROM node n
LEFT JOIN node p ON n.page_id = p.id
WHERE n.workspace_id = $1
  AND n.active = TRUE
  AND n.is_deleted = FALSE
  -- condition clauses added here
ORDER BY n.sequence ASC, n.id ASC
```

### Condition SQL Examples

**Class condition** (with inheritance via recursive CTE):
```sql
AND n.class_ids && (
  WITH RECURSIVE class_tree AS (
    SELECT id FROM node WHERE uuid = $2
    UNION
    SELECT ce.target_id FROM class_extend ce
    JOIN class_tree ct ON ce.source_id = ct.id
  )
  SELECT ARRAY_AGG(id) FROM class_tree
)::integer[]
```

**Property condition**:
```sql
AND EXISTS (
  SELECT 1 FROM node_property np
  JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
  WHERE np.node_id = n.id
    AND np.property_id = $3
    AND pvs.value_integer > $4
)
```

**Content condition**:
```sql
AND (
  SELECT string_agg(t.value, ' ')
  FROM jsonb_path_query(n.name::jsonb, '$..**."text"') AS t(value)
) ILIKE $5
```

**Reference condition**:
```sql
AND (
  EXISTS (SELECT 1 FROM node_link nl WHERE nl.source_id = n.id AND nl.target_id = $6)
  OR EXISTS (SELECT 1 FROM property_value_relation pvr WHERE pvr.node_id = n.id AND pvr.target_id = $6)
)
```

---

## Frontend: Query Builder UI

The QueryBuilder provides a visual interface for constructing queries:

```
ViewBuilder
├── ProseScopeSelector        (Scope selection)
├── QueryBlockList            (List of conditions)
│   ├── QueryBlockBuilder     (Individual condition/group)
│   │   ├── ProseConditionBuilder  (Natural-language condition editor)
│   │   ├── SelectionButton        (AND/OR/NOT toggle)
│   │   └── QueryBlockCard         (Card layout)
│   └── "Add condition" button
└── QuerySQLPreview           (SQL debug panel)
```

### Frontend Query Execution Hook

```typescript
// Execute a saved view's query
const { data: nodes } = useNodeViewQuery(viewId, {
  runtimeParams: { current_node_uuid: pageUuid },
  enrich: { children: true, properties: true }
});

// Execute an ad-hoc query
const { data } = useQuery_({
  query_ast: myQueryAST,
  limit: 50,
  enrich: { classes: true }
});

// Count results only
const { data: count } = useQueryCount({
  query_ast: myQueryAST
});
```

---

## Optimization

The query engine includes an optimizer (`query_ast_optimizer.py`) that simplifies the AST before SQL generation:

- Removes empty groups
- Flattens single-child groups
- Collapses nested AND-in-AND / OR-in-OR
- Deduplicates identical conditions

Metrics track AST nodes before/after optimization to measure effectiveness.

---

## SQL Caching

Generated SQL is cached (`query_sql_cache.py`) keyed by the serialized AST + workspace ID + current node UUID. Cache hits avoid recompiling the AST to SQL on repeated executions.
