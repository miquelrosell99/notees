# Properties System

The Properties system allows structured metadata to be attached to any node. Properties have typed values (numbers, text, dates, node references, selections) and can be defined globally or locally, with optional class-based assignment.

---

## Property Definition

A property is a reusable schema that defines what kind of value can be stored:

```python
@dataclass
class Property:
    id: int
    uuid: str
    name: str                         # "Priority", "Due Date", "Status"
    icon: Optional[str]               # Emoji icon
    type: PropertyType                # See types below
    is_multi: bool = False            # Allow multiple values
    is_system: bool = False           # System-defined, immutable
    is_local: bool = False            # Scoped to a single page
    node_id: Optional[int] = None     # Owner page (for local properties)
    icon_visibility: str = "hidden"   # "hidden", "before_content", "after_content"
```

---

## Property Types

| Type | Category | Storage | Example |
|------|----------|---------|---------|
| `integer` | Scalar | `value_integer` column | `42` |
| `float` | Scalar | `value_float` column | `3.14` |
| `boolean` | Scalar | `value_boolean` column | `true` |
| `text` | Relation | Block node reference | Rich text editor |
| `image` | Relation | Asset node reference | Uploaded image |
| `date` | Relation | Day node reference | `2026-02-16` |
| `node` | Relation | Node reference | Link to another page |
| `selection` | Selection | Selection line reference | Dropdown from predefined options |

### Category Behaviors

- **Scalar** types store primitive values directly in a dedicated column
- **Relation** types store references to other node IDs (text → block node, image → asset node, date → day page, node → any page)
- **Selection** types reference predefined option lines
- `text` and `image` are always **single-value** (never multi)

---

## Property Value Storage

Values are stored in three separate tables depending on the property category:

### Scalar Values (`property_value_scalar`)

```python
@dataclass
class PropertyValueScalar:
    id: int
    node_property_id: int    # Links to NodeProperty
    property_id: int
    node_id: int             # The node this value belongs to
    value_text: Optional[str]
    value_boolean: Optional[bool]
    value_float: Optional[float]
    value_integer: Optional[int]
```

Only one value column is used at a time based on property type:

```python
def get_value(self, property_type: PropertyType):
    if property_type == PropertyType.INTEGER:
        return self.value_integer
    elif property_type == PropertyType.FLOAT:
        return self.value_float
    elif property_type == PropertyType.BOOLEAN:
        return self.value_boolean
    elif property_type == PropertyType.DATE:
        return self.value_text  # ISO date string
```

### Relation Values (`property_value_relation`)

```python
@dataclass
class PropertyValueRelation:
    id: int
    node_property_id: int
    property_id: int
    node_id: int             # The node this value belongs to
    target_id: int           # The referenced node
```

### Selection Values (`property_value_selection`)

```python
@dataclass
class PropertyValueSelection:
    id: int
    node_property_id: int
    property_id: int
    node_id: int
    selection_line_id: int   # References a selection option
```

---

## Node Property (Assignment)

Before a value can be set, a property must be **assigned** to a node:

```python
@dataclass
class NodeProperty:
    id: int
    uuid: str
    node_id: int             # The node
    property_id: int         # The property definition
    property_type: PropertyType  # Cached from Property
```

The `NodeProperty` bridges node ↔ property and serves as the parent for all value records.

---

## Selection Lines (Options)

Selection-type properties have predefined options:

```python
@dataclass
class PropertySelectionLine:
    id: int
    property_id: int
    name: str               # "Low", "Medium", "High"
    icon: Optional[str]     # "🟢", "🟡", "🔴"
    order: int              # Display order
```

### Example: Creating a Selection Property

```http
POST /api/properties/

{
  "name": "Priority",
  "type": "selection",
  "is_multi": false,
  "selection_lines": ["Low", "Medium", "High", "Critical"]
}
```

### Managing Options

```http
# Add a new option
POST /api/properties/{property_id}/selection-lines
{ "name": "Urgent", "icon": "🔴", "order": 5 }

# Update an option
PUT /api/properties/{property_id}/selection-lines/{line_id}
{ "name": "Very Urgent", "icon": "🚨" }

# Delete an option (only if unused)
DELETE /api/properties/{property_id}/selection-lines/{line_id}
```

---

## Class Filters

Properties can be filtered to only show node references of specific classes:

```http
# Add filter: only show "Project" class nodes in this property
POST /api/properties/{property_id}/class-filters?class_node_id=42

# Remove filter
DELETE /api/properties/{property_id}/class-filters/{class_node_id}
```

When creating a `node`-type property, the `page` class filter is applied by default.

---

## Setting Property Values

### Unified Endpoint (Auto-Detection)

The simplest way to set a property value — automatically dispatches by type:

```http
POST /api/nodes/{node_id}/properties

# Integer
{ "property_id": 10, "value": 42 }

# Boolean
{ "property_id": 11, "value": true }

# Date (creates/links to day page)
{ "property_id": 12, "value": "2026-02-16" }

# Node reference
{ "property_id": 13, "value": 100 }  // target node ID

# Selection
{ "property_id": 14, "value": 5 }     // selection line ID

# Multi-value (array)
{ "property_id": 15, "value": [1, 2, 3] }  // multiple node IDs
```

### Removing a Property

```http
# Remove the property assignment and all its values
DELETE /api/nodes/{node_id}/properties/{property_id}
```

> **Note**: For `text` and `image` types, removing a property also deletes the target nodes (since they're floating blocks/assets with no other parent).

---

## Class Properties

Properties can be linked to classes so that **every node with that class automatically gets those properties**:

### Setting Up Class Properties

```http
# Link "Priority" and "Due Date" to the "Task" class
POST /api/properties/classes/{task_class_id}/properties
{ "property_id": 15, "sequence": 0 }

POST /api/properties/classes/{task_class_id}/properties
{ "property_id": 16, "sequence": 1, "default_value": "2026-12-31" }
```

### With Default Values

```python
@dataclass
class ClassProperty:
    id: int
    class_node_id: int       # The class node
    property_id: int          # The property definition
    sequence: int = 0         # Display order within the class
    hidden: bool = False      # Hidden from default view
    default_value_text: Optional[str] = None
    default_value_boolean: Optional[bool] = None
    default_value_float: Optional[float] = None
    default_value_integer: Optional[int] = None
    default_value_selection_line_id: Optional[int] = None
    default_value_target_id: Optional[int] = None
```

When a class is added to a node, all class properties are automatically assigned with their default values.

### Querying Class Properties

```http
# Get direct class properties
GET /api/properties/classes/{class_id}/properties

# Get including inherited properties from parent classes
GET /api/properties/classes/{class_id}/properties?include_inherited=true

# Get inherited properties with override info
GET /api/properties/classes/{class_id}/inherited-properties
```

---

## Local Properties

Properties scoped to a single page — only visible on that page and its blocks:

```http
POST /api/properties/

{
  "name": "Meeting Notes",
  "type": "text",
  "is_local": true,
  "node_id": 100
}
```

Local properties:
- Have `is_local=true` and `node_id` set to the owner page
- Don't appear in the global property list by default
- Are useful for page-specific metadata

```http
# List local properties for a page
GET /api/properties/local/{node_id}
```

---

## Multi-Value Properties

Properties with `is_multi=true` can store multiple values:

```http
# Set multiple node references
POST /api/nodes/{node_id}/properties
{ "property_id": 13, "value": [100, 101, 102] }
```

**Constraints:**
- `text` and `image` types are **always single-value** (cannot be multi)
- Switching from multi to single keeps only the first value per node

---

## Property Type Changes

Property types can only be changed **if no values exist**:

```http
# Check if type can be changed
GET /api/properties/{property_id}/can-delete

# Change type
POST /api/properties/{property_id}/change-type
{ "new_type": "integer", "new_is_multi": false }
```

---

## Frontend: Property Components

### PropertiesSection

The main component for displaying and editing properties on a page:

```
PropertiesSection
├── PropertyValue (integer/float — inline number input)
├── PropertyValue (boolean — checkbox)
├── TextPropertyBlock (text — full Lexical editor)
├── DatePropertyValue (date — calendar picker → creates day page)
├── NodeSelector (node — chip list with search)
├── Dropdown (selection — option picker)
├── PropertySuggestionPopup ("Add property" button)
└── ClassPropertiesEditor (for class nodes)
```

### Table View Integration

Properties appear as columns in the table view mode:

```
┌──────────────┬──────────┬────────────┬─────────┐
│ Name         │ Priority │ Due Date   │ Status  │
├──────────────┼──────────┼────────────┼─────────┤
│ Fix Bug #42  │ High     │ 2026-03-01 │ Active  │
│ Build API    │ Medium   │ 2026-04-15 │ Draft   │
└──────────────┴──────────┴────────────┴─────────┘
```

Column selection is persisted per view via the `shown_properties` field on `NodeView`.

### Batch Property Fetching

For performance, properties for multiple nodes are fetched in a single request:

```http
POST /api/nodes/batch/properties
{ "node_ids": [42, 43, 44, 45, 46] }
```

This uses 3 SQL queries total instead of N×3 (one per value table).

---

## System Properties

Some properties are system-defined and cannot be deleted:

| Property | UUID | Type | Purpose |
|----------|------|------|---------|
| `banner` | Fixed | `image` | Page banner image |
| `cover` | Fixed | `image` | Page cover image |

System properties have `is_system=true` and are managed internally.

---

## Property Icon Visibility

Controls where the property icon appears relative to block content:

| Value | Display |
|-------|---------|
| `hidden` | Icon not shown in block view |
| `before_content` | Icon shown before the block bullet |
| `after_bullet` | Icon shown after the bullet, before text |

```http
PUT /api/properties/{property_id}
{ "icon_visibility": "before_content" }
```
