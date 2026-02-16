# Links & Backlinks

Notees implements **bidirectional linking** — every reference from one node to another is tracked as an explicit entity, enabling rich backlink queries and graph visualization.

---

## Link Types

### Text Links (`[[nodeUuid]]`)

Inline references within block content. When a user types `[[` and selects a page, a link is embedded in the JSON AST:

```json
{
  "type": "paragraph",
  "children": [
    { "text": "See " },
    { "type": "link", "target": "abc-uuid", "linkUuid": "link-uuid-123", "children": [{ "text": "My Page" }] },
    { "text": " for details." }
  ]
}
```

Each text link creates a `NodeLink` record:

```python
@dataclass
class NodeLink:
    id: int
    source_id: int           # Node containing the link
    target_id: int           # Referenced node
    uuid: str                # Unique ID for this link instance
    position: int            # Character position in content
    is_tag: bool = False     # Whether this is a tag reference
    is_inline_class: bool = False  # Whether this is an inline class
    name: Optional[str] = None     # Custom display text
```

### Tag Links

Tags are a special form of link displayed with a `#` prefix. They work like text links but survive content re-parsing:

```http
# Add a tag
POST /api/nodes/{node_id}/tag-links
{ "target_node_id": 50 }

# Remove a tag (converts to regular link, doesn't delete)
DELETE /api/nodes/{node_id}/tag-links/{target_id}
```

Tags appear as chips below the page title. Since tags are just nodes (pages), they can have their own content, properties, and backlinks.

### Inline Class References (`{{classUuid}}`)

When blocks have inline class assignments (via `{{classId}}` syntax in content), these are tracked as links with `is_inline_class=true`:

```python
# Parsed from content AST
NodeLink(source_id=block_id, target_id=class_node_id, is_inline_class=True)
```

### Property Value Relations

When a property of type `node` or `date` references another node, this creates a backlink via the `property_value_relation` table (not `NodeLink`). Both text links and property relations appear in backlink queries.

---

## Link Parsing

Links are parsed from the JSON AST (not raw text) by the `LinkParsingService`:

```python
class LinkParsingService:
    def parse_links(self, content: str) -> List[Tuple[str, int, str]]:
        """Extract (target_uuid, position, link_uuid) from JSON AST."""
        
    def update_node_links(self, node_id: int, content: str):
        """Delete old text links, create new ones from current content."""
        
    def update_inline_classes(self, node_id: int, content: str):
        """Delete old inline class links, create new ones."""
```

### Parse Flow

```
Block Content Updated
       │
       ▼
 Parse JSON AST
       │
       ├── Extract text links  → update_node_links()
       │   ├── Delete old non-tag text links
       │   ├── Create new NodeLink records
       │   └── Log activity for new page links
       │
       └── Extract inline classes → update_inline_classes()
           ├── Delete old inline class links
           ├── Create new NodeLink records
           └── Update node's class_ids array
```

### Link Preservation Rules

- **Tag links** are preserved across content edits (they're stored independently)
- **Text links** are re-parsed on every content update
- New link UUID is generated on creation; existing UUIDs are preserved if the target hasn't changed

---

## Backlinks

Backlinks are the reverse side of links — "what pages link to this one?"

### Getting Backlinks

```http
GET /api/nodes/{node_id}/backlinks?include_inherited=true
```

The `BacklinkInfo` dataclass provides rich provenance:

```python
@dataclass
class BacklinkInfo:
    link: NodeLink                    # The link record
    source_node_id: int              # Node containing the link
    source_node_name: str
    source_node_uuid: str
    source_node_is_page: bool
    source_page_id: Optional[int]     # Page containing the source block
    source_page_name: Optional[str]
    source_page_uuid: Optional[str]
    property_id: Optional[int]        # If link is via a property
    property_name: Optional[str]
    text_property_root_block_id: Optional[int]  # If inside a text property
    breadcrumb_path: List[Tuple]      # [(node_id, name, is_property_segment), ...]
```

### Backlink Sources

Backlinks come from two sources:

1. **Text links** — `node_link` table entries where `target_id` matches
2. **Property relations** — `property_value_relation` entries where `target_id` matches

Both are unified in the backlinks API response.

---

## Linked References

The "Linked References" section on each page shows all nodes that reference the page, with full context:

```http
GET /api/nodes/{node_id}/linked-references
```

**Response structure:**

```json
[
  {
    "source_node": {
      "id": 42,
      "uuid": "...",
      "name": "Meeting Notes",
      "children": [...]
    },
    "source_page": {
      "id": 40,
      "uuid": "...",
      "name": "Meetings"
    },
    "link_type": "text_link",
    "breadcrumb_path": [
      [40, "Meetings", false],
      [41, "Weekly", false],
      [42, "Meeting Notes", false]
    ],
    "property_id": null,
    "property_name": null,
    "text_property_root_block_id": null
  }
]
```

### Text Property Context

If a link is inside a text property's block hierarchy, the backlink is enriched with property provenance:

```json
{
  "source_node": { ... },
  "property_id": 15,
  "property_name": "Description",
  "text_property_root_block_id": 200,
  "breadcrumb_path": [
    [100, "Project Page", false],
    [null, "Description", true],     // Property segment
    [201, "Block containing link", false]
  ]
}
```

---

## Property Backlinks

Separate from text backlinks, property backlinks show pages that reference a node via typed properties:

```http
GET /api/nodes/{node_id}/property-backlinks
```

**Response:**

```json
[
  {
    "source_page": { "id": 100, "name": "Project Alpha", ... },
    "property_id": 15,
    "property_name": "Assigned To"
  }
]
```

For day nodes, this also searches `property_value_scalar` for date value matches.

---

## Unlinked References

Unlinked references are nodes whose content contains the page name as text but don't have an explicit link. These are powered by the query system:

```json
{
  "scope": { "scope_type": "entire_workspace" },
  "root_group": {
    "logic": "and",
    "children": [
      { "type": "content", "operator": "contains", "value": "{current_node_name}" },
      { "type": "not", "child": { "type": "reference", "target_uuid": "{current_node_uuid}" } }
    ]
  }
}
```

---

## Aliases

Aliases let one page serve as an alternative reference to another:

```http
# Add alias
POST /api/nodes/{node_id}/aliases
{ "alias_node_id": 201 }

# Remove alias
DELETE /api/nodes/{node_id}/aliases/{alias_id}

# List aliases
GET /api/nodes/{node_id}/aliases
```

**Constraints:**
- Only pages can be aliases
- No chaining (an alias can't be an alias of another alias)
- No self-aliases
- Backlinks to the alias are redirected to the main node

When navigating to an aliased node, the UI automatically redirects to the main node.

---

## Link Display Names

Links can have custom display text that differs from the target's name:

```http
PATCH /api/nodes/link/name
{
  "link_uuid": "link-uuid-123",
  "name": "custom display text"
}
```

Setting `name` to `null` resets to the target's default name.

---

## Classes Path

Each node maintains a `classes_path` array — the accumulated class IDs from all ancestors:

```
Page A (classes: [Project])
  └── Block B (classes: [Task])
       └── Block C (classes: [])
           classes_path = [Project, Task]  // inherited from ancestors
```

This enables efficient query matching for "nodes under a project" without traversing the tree. The path is updated whenever:
- A class is added/removed from a node
- A node is moved to a new parent
- Content with inline classes changes

```python
class LinkParsingService:
    def update_classes_path(self, node_id: int):
        """Compute inherited classes from ancestors' class_ids."""
        
    def update_classes_path_for_descendants(self, node_id: int):
        """Cascade classes_path update to all descendants."""
```

---

## Deletion & Link Cleanup

When a node is soft-deleted, all references to it are cleaned up:

1. **Text links** in other nodes are replaced with **plain text** (the link text is preserved but the link structure is removed from the AST)
2. **Inline class references** pointing to the deleted node are removed
3. **Property value relations** referencing the deleted node are deleted
4. The changes cascade to all descendant blocks

This ensures that deleting a page doesn't leave broken links throughout the workspace.

> **Important**: Restoring a node from trash does **not** re-create the backlinks. The text replacements are permanent.

---

## Frontend Link Components

### Link Rendering in the Editor

The Lexical editor uses `PillNode` to render inline links as interactive pills:

```
┌──────────────────────────────────┐
│ See [[📄 My Page]] for details. │
└──────────────────────────────────┘
       ↑ clickable pill
```

Clicking a pill navigates to the target page. Shift-clicking opens in the right sidebar.

### NodeLinkPlugin

The `NodeLinkPlugin` Lexical plugin handles:
- Converting `[[` typing into link creation
- Opening a search popup for target selection
- Creating `PillNode` elements in the editor
- Syncing link changes back to the AST

### Linked References Section

```
LinkedReferences
├── QueryNodeCollection (view_type="linked_references")
│   ├── NodeCollection (list of referencing nodes)
│   │   └── BlockEditor (per node, showing context)
│   └── View tabs (custom filtered views)
└── PropertyReferencesSection (property backlinks)
```

The linked references count is shown in badges throughout the UI:

```typescript
const { count, isLoading } = useLinkedReferencesCount(nodeId);
// count = text backlink count + property backlink count
```

---

## Graph Visualization

Links power the workspace graph view:

```http
GET /api/nodes/workspace/nodes    # All nodes
POST /api/nodes/links             # Links between nodes
{ "node_ids": [1, 2, 3, ...], "scope": "between" }
```

**Link types in the graph:**

| Type | Description | Visual |
|------|-------------|--------|
| `reference` | Text link (`[[...]]`) | Solid line |
| `parent` | Parent-child hierarchy | Dashed line |
| `class` | Class assignment | Dotted line |
| `extends` | Class inheritance | Double line |
| `property-reference` | Property value relation | Thin line |
