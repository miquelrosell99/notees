# Implementation Plan: Class Extension, Full-Text Search, and Drag & Drop

## Summary

This document outlines the implementation of three major features:
1. Class Extension System (inheritance)
2. Full-Text Search
3. Drag & Drop Improvements

## Status

### ✅ Completed
- Added `extends` system property to backend constants
- Added `extends` to frontend constants  
- Created `ClassExtensionService` with inheritance logic, circular detection
  
### 🚧 In Progress / Todo

## Feature 1: Class Extension System

### Backend Changes

#### 1. Database Schema (`app/db/schema/`)
- ✅ Added `extends` system property UUID: `00000000-0000-0000-0000-000000000008`
- The property uses existing `property_value_relation` table (node-type, multi-value)

#### 2. Class Extension Service (`app/domain/services/class_extension_service.py`)
- ✅ Created with methods:
  - `get_extended_classes(class_node_id)` - direct extensions
  - `get_all_extended_classes(class_node_id)` - multi-level with circular detection
  - `get_inherited_properties(class_node_id)` - merged properties with override detection
  - `validate_extends_acyclic(...)` - pre-validation before saving
  - `get_classes_extended_by(class_node_id)` - reverse lookup (for "Extended By" section)

#### 3. API Endpoints (`app/routers/properties/classes.py`)
**TODO:** Add these endpoints:
```python
@router.get("/classes/{class_node_id}/inherited-properties")
async def get_inherited_properties(...)
    # Returns properties inherited from extended classes
    # Includes `is_overridden` flag

@router.get("/classes/{class_node_id}/extended-by")
async def get_extended_by_classes(...)
    # Returns flat list of classes that extend this one
    # Used for "Extended By" section (like child pages)

@router.post("/classes/{class_node_id}/validate-extends")
async def validate_extends(class_ids: List[int], ...)
    # Validates that adding these extends won't create cycles
```

### Frontend Changes

#### 1. Types (`frontend/src/types/api.ts`)
**TODO:** Add:
```typescript
export interface InheritedProperty extends ClassProperty {
  from_class_id: number;
  from_class_name: string;
  is_overridden: boolean; // True if exists as dedicated property
}

export interface ExtendedByClass {
  id: number;
  uuid: string;
  name: string;
  icon: string | null;
}
```

#### 2. API Hooks (`frontend/src/hooks/`)
**TODO:** Add hooks:
- `useInheritedProperties(classNodeId)`
- `useExtendedByClasses(classNodeId)`
- Mutation hooks for validating extends

#### 3. PropertiesSection Component (`frontend/src/components/PropertiesSection.tsx`)
**TODO:** Add "Inherited Properties" section:
- Display after dedicated class properties
- Show properties with grey styling
- Show source class name ("from ClassX")
- If `is_overridden === true`, show with strikethrough + tooltip

#### 4. Class View / Node View (`frontend/src/views/NodeView.tsx`)
**TODO:** Add "Extended By" section:
- Similar to "Child Pages" section
- Only visible when class is used as an extend
- Flat list, no hierarchy
- Use NodeCollection component with list view

#### 5. Linked References Filter
**TODO:** Modify linked references query/display:
- Hide links from `extends` property (like how `classes` is hidden)
- Backend: Modify backlinks query to exclude extends property
- Or filter on frontend based on SYSTEM_PROPERTY_UUIDS.extends

---

## Feature 2: Full-Text Search

### Backend Changes

#### 1. Database Schema
**TODO:** Add full-text search:
```sql
-- Add tsvector column to node table (if not exists)
ALTER TABLE node ADD COLUMN search_vector tsvector;

-- Create GIN index for fast full-text search
CREATE INDEX idx_node_search_vector ON node USING GIN(search_vector);

-- Create trigger to auto-update search_vector
CREATE TRIGGER node_search_vector_update BEFORE INSERT OR UPDATE ON node
FOR EACH ROW EXECUTE FUNCTION
tsvector_update_trigger(search_vector, 'pg_catalog.english', name);
```

#### 2. Update Repository (`app/domain/repositories/postgres_node.py`)
The `search()` method already uses FTS! But may need enhancement:
```python
async def search(self, query: str, limit: int = 50) -> List[Node]:
    # Current implementation uses ts_rank
    # Enhancement: Add relevance scoring, search in properties, etc.
```

**Enhancements to consider:**
- Search in property values (text properties)
- Search in block content under pages
- Configurable search scopes (pages only, blocks, etc.)

#### 3. Search Endpoint Enhancement (`app/routers/nodes/search.py`)
**TODO:** Add parameters:
```python
@router.get("/search")
async def search_nodes(
    q: str,
    limit: int = 50,
    scope: str = "all",  # all | pages | blocks
    include_properties: bool = False,
):
```

### Frontend Changes

#### 1. Search Component
**TODO:** Create `frontend/src/components/SearchBar.tsx` or enhance existing:
- Global search input (⌘K shortcut)
- Display results with relevance scores
- Show page/block preview
- Keyboard navigation

#### 2. Search API Hook
**TODO:** Add `frontend/src/hooks/useSearch.ts`:
```typescript
export function useSearch(query: string, options?: SearchOptions) {
  return useQuery({
    queryKey: ['search', query, options],
    queryFn: () => api.searchNodes(query, options),
    enabled: query.length >= 2,
  });
}
```

---

## Feature 3: Drag & Drop Improvements

### Current State
- Basic drag & drop exists in `ListSortable.tsx` for reordering
- Blocks can be reordered within the same parent

### Goal
- Drag a block **below** another → add as sibling
- Drag **indented** below → add as child
- Visual indicators for drop zones

### Implementation

#### 1. Enhanced Drag State (`frontend/src/hooks/useDragPreview.ts`)
**TODO:** Extend state to include:
```typescript
interface DragState {
  draggedNode: Node;
  dropTarget: {
    nodeId: number;
    position: 'before' | 'after' | 'child';
  } | null;
  indentLevel: number; // Based on mouse X position
}
```

#### 2. Block Component (`frontend/src/components/blocks/Block.tsx`)
**TODO:** Add drop zone handlers:
```typescript
const handleDragOver = (e: React.DragEvent) => {
  e.preventDefault();
  
  // Calculate indent level from mouse X
  const rect = e.currentTarget.getBoundingClientRect();
  const relativeX = e.clientX - rect.left;
  const indentLevel = Math.floor(relativeX / 24); // 24px per indent
  
  // Determine drop position
  const relativeY = e.clientY - rect.top;
  const halfHeight = rect.height / 2;
  
  if (indentLevel > 0) {
    setDropPosition({ position: 'child', indentLevel });
  } else if (relativeY < halfHeight) {
    setDropPosition({ position: 'before' });
  } else {
    setDropPosition({ position: 'after' });
  }
};

const handleDrop = async (e: React.DragEvent) => {
  const draggedNodeId = parseInt(e.dataTransfer.getData('nodeId'));
  const { position, indentLevel } = dropPosition;
  
  if (position === 'child') {
    // Move as child: parent_id = target node, sequence = 0
    await moveNode({
      nodeId: draggedNodeId,
      parentId: node.id,
      sequence: 0,
    });
  } else {
    // Move as sibling: parent_id = target's parent, sequence adjusted
    const targetSequence = position === 'before' ? node.sequence : node.sequence + 1;
    await moveNode({
      nodeId: draggedNodeId,
      parentId: node.parent_id,
      sequence: targetSequence,
    });
  }
};
```

#### 3. Visual Indicators
**TODO:** Add CSS for drop zones:
```css
.block--drop-target-before::before {
  content: '';
  position: absolute;
  top: -2px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent);
}

.block--drop-target-child {
  background: var(--accent-bg);
  border-left: 2px solid var(--accent);
}
```

#### 4. Backend Validation
The `move()` method in `postgres_node.py` already handles parent/sequence changes correctly with:
- Sibling resequencing
- Page ID recomputation
- Classes path updates

---

## Testing Plan

### 1. Class Extension
- [ ] Create class A with properties P1, P2
- [ ] Create class B that extends A
- [ ] Verify B shows inherited properties from A
- [ ] Create class C that extends B
- [ ] Verify C shows inherited from both B and A (multi-level)
- [ ] Add P1 as dedicated property to C → verify it shows as "overridden"
- [ ] Try to create circular: A extends B, B extends A → verify error
- [ ] Check "Extended By" section shows correct classes

### 2. Full-Text Search
- [ ] Search for partial node names → verify results
- [ ] Search for common words → verify ranking
- [ ] Search in properties → verify results include property matches
- [ ] Test search performance with 1000+ nodes

### 3. Drag & Drop
- [ ] Drag block below sibling → verify reordering
- [ ] Drag block indented below sibling → verify becomes child
- [ ] Drag block to different page → verify parent change
- [ ] Test with nested hierarchies
- [ ] Verify visual indicators are clear

---

## Priority Order

1. **Class Extension Backend** (highest value, enables powerful class system)
   - API endpoints
   - Property inheritance resolution
   
2. **Class Extension Frontend**
   - Inherited properties display
   - Extended By section
   
3. **Full-Text Search** (if not already sufficient)
   - Enhance existing search with better UI
   
4. **Drag & Drop** (polish feature)
   - Drop zones with indent detection
   - Visual feedback

---

## Key Files to Modify

### Backend
- ✅ `app/db/schema/constants.py` - extends property added
- ✅ `app/domain/services/class_extension_service.py` - created
- `app/routers/properties/classes.py` - add endpoints
- `app/domain/repositories/postgres_property.py` - may need helper methods

### Frontend
- ✅ `frontend/src/constants/systemProperties.ts` - extends added
- `frontend/src/types/api.ts` - add InheritedProperty, ExtendedByClass
- `frontend/src/components/PropertiesSection.tsx` - add inherited section
- `frontend/src/views/NodeView.tsx` - add Extended By section
- `frontend/src/hooks/useProperties.ts` - add inheritance hooks
- `frontend/src/components/blocks/Block.tsx` - enhance drag & drop
- `frontend/src/components/SearchBar.tsx` - create or enhance

---

## Notes

- The `extends` property behaves like a normal node-type property
- Links from `extends` appear in graph view (desired)
- Links from `extends` should be hidden from Linked References (filter needed)
- Circular inheritance detection happens server-side
- Frontend should validate but trust backend for final check
