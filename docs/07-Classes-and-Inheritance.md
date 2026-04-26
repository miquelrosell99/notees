# Classes & Inheritance

Classes are Notees' type system — they categorize nodes, define shared properties, and support inheritance through an extension mechanism.

---

## What is a Class?

A class is simply a **Node with `is_class=true`**. Since classes are nodes, they have their own pages, content, properties, and backlinks — just like any other page.

```
Node: "Project" (is_class=true, is_page=true)
  ├── Content blocks (describing the class)
  ├── Properties (defined for all "Project" nodes)
  └── Linked references (all nodes classified as "Project")
```

### System Classes

Notees includes 14 built-in system classes with fixed UUIDs:

| Class | Purpose | Constraints |
|-------|---------|-------------|
| `page` | All pages | System-managed |
| `class` | All class nodes | Pages only |
| `day` | Daily journal pages | System-managed, cannot manually add/remove |
| `month` | Monthly journal pages | System-managed |
| `year` | Yearly journal pages | System-managed |
| `comment` | Comment nodes | Blocks only |
| `task` | Task/todo items | — |
| `template` | Template nodes | — |
| `asset` | File attachments | — |
| `quote` | Block quotes | Blocks only |
| `query` | Query blocks | Blocks only |
| `code` | Code blocks | — |
| `whiteboard` | Whiteboard pages | — |
| `card` | Card items | — |

**Protected date classes** (`day`, `month`, `year`) cannot be manually added or removed — they're managed by the daily journal system.

**Block-only classes** (`query`, `comment`, `quote`) can only be added to blocks, not pages.

---

## Assigning Classes to Nodes

### Via API

```http
# Add a class to a node
POST /api/nodes/{node_id}/classes
{ "class_node_id": 42 }

# Remove a class from a node
DELETE /api/nodes/{node_id}/classes/{class_id}
```

### Via Frontend

Classes are assigned using the `NodeSelector` component below the page title:

```
┌──────────────────────────────────────┐
│ 📋 My Project Page                  │
│                                      │
│ Classes: [Project ×] [Active ×] [+] │
│ Tags:    [important ×] [work ×] [+] │
└──────────────────────────────────────┘
```

### During Node Creation

```http
POST /api/nodes/
{
  "name": "Build Website",
  "classes": [42, 43]
}
```

### Inline Classes (`{{classUuid}}`)

Classes can be applied inline within block content using the `{{classId}}` syntax. These are parsed and stored as links with `is_inline_class=true`.

---

## What Happens When a Class is Added

When you add a class to a node, several things happen:

1. **Validation** — checks constraints (date protection, block-only, uniqueness)
2. **Flag update** — if the class maps to a flag (e.g., `task` → no flag, but `query` → special behavior), the flag is set
3. **Class IDs update** — the class is added to the node's `class_ids` array
4. **Property application** — all properties defined for that class are assigned to the node with default values
5. **Classes path update** — descendants' `classes_path` is recalculated

```python
# Mapping from class UUID to node flag
CLASS_UUID_TO_FLAG = {
    "day_uuid": "is_day",
    "month_uuid": "is_month",
    "year_uuid": "is_year",
    "asset_uuid": "is_asset",
    "template_uuid": "is_template",
    "comment_uuid": "is_comment",
}
```

### Special Behavior: Query Class

Adding the `query` class to a block automatically creates a `main_content` NodeView with an empty query. Removing it deletes associated views.

---

## Class Properties

Properties can be linked to classes, so every node with that class automatically gets those properties:

### Defining Class Properties

```http
POST /api/properties/classes/{class_id}/properties
{
  "property_id": 15,
  "sequence": 0,
  "default_value": "medium"
}
```

### ClassProperty Schema

```python
@dataclass
class ClassProperty:
    id: int
    class_node_id: int       # The class
    property_id: int         # The property definition
    sequence: int            # Display order
    hidden: bool             # Hidden from default view
    # Default values (one per type)
    default_text: Optional[str]
    default_boolean: Optional[bool]
    default_float: Optional[float]
    default_integer: Optional[int]
    default_node_id: Optional[int]
    default_selection_id: Optional[int]
```

### Example: "Task" Class Properties

```http
# 1. Create properties
POST /api/properties/
{ "name": "Status", "type": "selection", "selection_lines": ["Todo", "In Progress", "Done"] }
→ { "id": 15 }

POST /api/properties/
{ "name": "Due Date", "type": "date" }
→ { "id": 16 }

POST /api/properties/
{ "name": "Priority", "type": "integer" }
→ { "id": 17 }

# 2. Link properties to class with defaults
POST /api/properties/classes/{task_class_id}/properties
{ "property_id": 15, "sequence": 0, "default_value": 1 }  # Default: "Todo"

POST /api/properties/classes/{task_class_id}/properties
{ "property_id": 16, "sequence": 1 }  # No default

POST /api/properties/classes/{task_class_id}/properties
{ "property_id": 17, "sequence": 2, "default_value": 3 }  # Default: 3
```

Now, adding the "Task" class to any node will automatically assign Status (=Todo), Due Date, and Priority (=3).

---

## Class Inheritance (Extends)

Classes support **single and multiple inheritance** via the `extends` mechanism:

```
          ┌─────────────┐
          │   Vehicle    │
          │ (properties: │
          │  color, year)│
          └──────┬───────┘
                 │ extends
          ┌──────┴──────┐
          │             │
    ┌─────┴─────┐ ┌────┴─────┐
    │    Car    │ │   Truck   │
    │(properties│ │(properties│
    │  doors)   │ │  payload) │
    └───────────┘ └───────────┘
```

### Setting Up Inheritance

```http
# Car extends Vehicle
POST /api/properties/classes/{car_class_id}/extends
{ "extends_class_node_id": vehicle_class_id, "sequence": 0 }

# Truck extends Vehicle
POST /api/properties/classes/{truck_class_id}/extends
{ "extends_class_node_id": vehicle_class_id, "sequence": 0 }
```

### Inherited Properties

When a class extends another, it inherits all parent properties:

```http
# Get inherited properties for "Car"
GET /api/properties/classes/{car_class_id}/inherited-properties
```

**Response:**

```json
[
  {
    "property_id": 10,
    "property_name": "Color",
    "property_type": "text",
    "from_class_id": 1,
    "from_class_name": "Vehicle",
    "sequence": 0,
    "is_overridden": false
  },
  {
    "property_id": 11,
    "property_name": "Year",
    "property_type": "integer",
    "from_class_id": 1,
    "from_class_name": "Vehicle",
    "sequence": 1,
    "is_overridden": false
  }
]
```

### Property Override

A child class can override a parent property by defining the same property:

```http
# Override "Color" property in "Car" class (with different defaults)
POST /api/properties/classes/{car_class_id}/properties
{ "property_id": 10, "default_value": "Red" }
```

Now the inherited property shows `is_overridden: true`.

### Circular Inheritance Prevention

The system validates against circular inheritance:

```http
# Validate before adding
POST /api/properties/classes/{class_id}/validate-extends
{ "extends_class_node_id": potential_parent_id }
```

If a cycle is detected, a `CircularInheritanceError` is raised with the cycle path.

---

## Querying by Class

### Direct Class Query

```http
# All nodes with the "Project" class
GET /api/nodes/classes/{project_class_id}/nodes
```

This uses `ClassExtensionService.get_all_subclasses()` to include nodes of any subclass.

### Query AST: Class Condition

```json
{
  "type": "class",
  "class_uuid": "project-uuid"
}
```

The SQL generation uses a recursive CTE to match the class **and all subclasses**:

```sql
WITH RECURSIVE class_tree AS (
    SELECT id FROM node WHERE uuid = $1
    UNION ALL
    SELECT ce.target_id FROM class_extend ce
    JOIN class_tree ct ON ce.source_id = ct.id
)
SELECT ...
WHERE n.class_ids && (SELECT ARRAY_AGG(id) FROM class_tree)::integer[]
```

### Query AST: Extends Condition

Find classes that extend a base class:

```json
{
  "type": "extends",
  "extends_class_uuid": "vehicle-uuid"
}
```

---

## Classes Path (Inherited Classes)

Each node maintains a `classes_path` array — accumulated class IDs from all ancestors:

```
Page: "Company" (classes: [Organization])
  └── Page: "Engineering" (classes: [Department])
       └── Block: "Q1 Goals"
           classes = []
           classes_path = [Organization, Department]
```

This enables queries like "find all blocks under an Organization" without tree traversal.

The path is recalculated when:
- A class is added/removed from any ancestor
- A node is moved to a new parent
- Inline classes change in content

---

## Frontend Components

### NodeSelector (Class Assignment)

The `NodeSelector` component provides a chip-based interface for adding/removing classes:

```
Classes: [📋 Project ×] [🔴 Urgent ×] [+]
                                        ↑
                              Opens search popup
                              with class suggestions
```

Features:
- Search for existing classes
- Create new class inline
- Remove class (with constraint validation)
- Displays class icon and name

### ClassPropertiesEditor (Class Definition)

For class pages, the `ClassPropertiesEditor` shows and manages the class's property definitions:

```
┌──────────────────────────────────────────┐
│ Properties for "Task" class              │
│                                          │
│  ☐ Status (Selection)      [Default: Todo] [×]
│  📅 Due Date (Date)         [No default]    [×]
│  🔢 Priority (Integer)      [Default: 3]    [×]
│                                          │
│  [+ Add Property]                        │
│                                          │
│ Extends: [Vehicle ×] [+]                │
└──────────────────────────────────────────┘
```

### Classed Nodes Section

On class pages, a "Classed Nodes" section shows all nodes with that class:

```
┌──────────────────────────────────────────┐
│ ▶ Classed Nodes (12)                     │
│                                          │
│  [List] [Table] [Card] [Graph]           │
│                                          │
│  • Build Website                         │
│  • Fix Bug #42                           │
│  • Design System Update                  │
│  ...                                     │
└──────────────────────────────────────────┘
```

This is powered by a default query view of type `classed_nodes`.

### Extended By Section

Shows classes that extend this class:

```
┌──────────────────────────────────────────┐
│ ▶ Extended By (3)                        │
│                                          │
│  • Car                                   │
│  • Truck                                 │
│  • Motorcycle                            │
└──────────────────────────────────────────┘
```

---

## Frontend Hooks

```typescript
// List all classes
const { data: classes } = useClasses();

// Search classes
const { data: results } = useSearchClasses("proj");

// Get nodes with a class
const { data: nodes } = useNodesWithClass(classId);

// Add/remove class mutations
const addClass = useAddClass();
const removeClass = useRemoveClass();

addClass.mutate({ nodeId: 42, classNodeId: projectClassId });
removeClass.mutate({ nodeId: 42, classId: projectClassId });

// Class properties
const { data: props } = useClassProperties(classId, true); // include_inherited
const { data: extends_ } = useClassExtends(classId);
const addPropToClass = useAddPropertyToClass();
const addExtends = useAddClassExtends();

// System classes
const { systemClasses, systemClassIds } = useSystemClasses();
```
