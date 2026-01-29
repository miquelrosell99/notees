# Migration Plan: Classes as Database Field

## Overview

Replace the current `classes` property implementation (stored via `property_value_relation`) with a direct `class_ids` column on the `node` table. This simplifies queries, improves performance, and removes the indirection through the property system while maintaining the same UI and API behavior.

---

## Current State Analysis

### How Classes Work Today

1. **Storage**: Classes are stored as a system property (`uuid: 00000000-0000-0000-0000-000000000002`)
   - `node_property` table links node → property
   - `property_value_relation` table stores actual class assignments (node_id → target_id)

2. **Reading Classes**: `_get_class_ids_batch()` in [helpers.py](app/routers/nodes/helpers.py#L184)
   ```sql
   SELECT pvr.node_id, array_agg(pvr.target_id) as class_ids
   FROM property_value_relation pvr
   JOIN property p ON pvr.property_id = p.id
   JOIN node n ON pvr.node_id = n.id
   WHERE p.name = 'classes' ...
   ```

3. **Adding/Removing Classes**: Via `NodeService.add_class()` / `remove_class()` in [node_service.py](app/domain/services/node_service.py#L877)
   - Uses `PropertyRepository.set_relation_value()` / `remove_relation_value()`
   - Also updates flags (`is_page`, `is_class`, etc.) via `_update_flags_from_classes()`

4. **API Endpoints**: [classes.py](app/routers/nodes/classes.py)
   - `POST /{node_id}/classes` - add class
   - `DELETE /{node_id}/classes/{class_id}` - remove class
   - `GET /classes/{class_id}/nodes` - get nodes with class

5. **Frontend Hooks**: [useNodeMutations.ts](frontend/src/hooks/useNodeMutations.ts#L977)
   - `useAddClass()` → `POST /api/nodes/{id}/classes`
   - `useRemoveClass()` → `DELETE /api/nodes/{id}/classes/{class_id}`

---

## Target State

### Schema Change

Add `class_ids` column directly to `node` table:

```sql
ALTER TABLE node ADD COLUMN class_ids INTEGER[] DEFAULT '{}';
CREATE INDEX idx_node_class_ids ON node USING GIN (class_ids);
```

### Key Benefits

1. **Simpler queries**: `WHERE $1 = ANY(class_ids)` instead of 3-table JOINs
2. **Better performance**: GIN index on array is faster than JOINs
3. **Atomic updates**: Single UPDATE instead of INSERT/DELETE on multiple tables
4. **No orphaned records**: No `property_value_relation` cleanup needed on node delete
5. **Consistent with `classes_path`**: Already using array pattern for inherited classes

---

## Migration Phases

### Phase 1: Database Schema (Non-Breaking)

**Files to modify:**
- [app/db/schema/sql.py](app/db/schema/sql.py) - Add `class_ids` column
- [app/db/migrations/](app/db/migrations/) - Create migration script

**Migration script** (`add_class_ids_column.sql`):
```sql
-- Add class_ids column to node table
ALTER TABLE node ADD COLUMN IF NOT EXISTS class_ids INTEGER[] DEFAULT '{}';

-- Create GIN index for fast array queries
CREATE INDEX IF NOT EXISTS idx_node_class_ids ON node USING GIN (class_ids);

-- Migrate existing data from property_value_relation
UPDATE node n SET class_ids = COALESCE((
    SELECT array_agg(pvr.target_id ORDER BY pvr."order")
    FROM property_value_relation pvr
    JOIN property p ON pvr.property_id = p.id
    WHERE pvr.node_id = n.id 
      AND p.name = 'classes'
      AND p.graph_id = n.graph_id
), '{}');
```

**Estimated effort**: 1 hour

---

### Phase 2: Domain Layer Changes

**Files to modify:**

#### 2.1 Node Entity
- [app/domain/entities/node.py](app/domain/entities/node.py)

```python
# Add new field to Node dataclass
class_ids: List[int] = field(default_factory=list)  # Direct class references
```

**Remove:**
```python
_classes: List[int] = field(default_factory=list, repr=False)  # No longer needed
```

#### 2.2 Node Repository  
- [app/domain/repositories/postgres_node.py](app/domain/repositories/postgres_node.py)

**Modify `row_to_node()`:**
```python
def row_to_node(self, row: Record) -> Node:
    # ... existing code ...
    class_ids = row.get('class_ids', []) or []
    return Node(
        # ... existing fields ...
        class_ids=class_ids,
    )
```

**Modify `_build_node_values()` for INSERT/UPDATE:**
```python
# Include class_ids in INSERT/UPDATE statements
```

#### 2.3 Node Service
- [app/domain/services/node_service.py](app/domain/services/node_service.py)

**Replace `add_class()` method:**
```python
async def add_class(self, node_id: int, class_node_id: int, *, _system_call: bool = False) -> bool:
    """Add a class to a node using direct class_ids array."""
    async with self._pool.acquire() as conn:
        # Get current class_ids
        row = await conn.fetchrow(
            "SELECT class_ids FROM node WHERE id = $1 AND graph_id = $2",
            node_id, self._graph_id
        )
        if not row:
            return False
        
        current = row['class_ids'] or []
        if class_node_id in current:
            return False  # Already has this class
        
        # Validate system class constraints (existing logic)
        # ...
        
        # Update with new class
        new_class_ids = current + [class_node_id]
        await conn.execute(
            "UPDATE node SET class_ids = $1, write_date = NOW() WHERE id = $2",
            new_class_ids, node_id
        )
        
        # Update flags (existing logic)
        await self._update_flags_from_classes(node_id, new_class_ids)
        return True
```

**Replace `remove_class()` method:**
```python
async def remove_class(self, node_id: int, class_node_id: int) -> bool:
    """Remove a class from a node using direct class_ids array."""
    async with self._pool.acquire() as conn:
        await conn.execute(
            "UPDATE node SET class_ids = array_remove(class_ids, $1), write_date = NOW() WHERE id = $2",
            class_node_id, node_id
        )
        # Update flags
        # ...
```

**Replace `get_node_classes()` method:**
```python
async def get_node_classes(self, node_id: int) -> List[Node]:
    """Get all classes applied to a node."""
    async with self._pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT class_ids FROM node WHERE id = $1", node_id
        )
        if not row or not row['class_ids']:
            return []
        
        rows = await conn.fetch(
            "SELECT * FROM node WHERE id = ANY($1)", row['class_ids']
        )
        return [self._node_repo.row_to_node(r) for r in rows]
```

**Remove dependency on `classes_property_id`:**
- Remove `self._classes_property_id` from constructor
- Remove all `PropertyRepository` calls for classes

**Estimated effort**: 3-4 hours

---

### Phase 3: Router/Helper Changes

**Files to modify:**

#### 3.1 Helper Functions
- [app/routers/nodes/helpers.py](app/routers/nodes/helpers.py)

**Replace `_get_class_ids_batch()`:**
```python
async def _get_class_ids_batch(pool, graph_id: int, node_ids: List[int]) -> Dict[int, List[int]]:
    """Fetch class_ids directly from node table."""
    if not node_ids:
        return {}
    
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, class_ids FROM node WHERE id = ANY($1) AND graph_id = $2",
            node_ids, graph_id
        )
    
    return {row['id']: row['class_ids'] or [] for row in rows}
```

This is now **much simpler** - no JOINs needed!

#### 3.2 Classes Router
- [app/routers/nodes/classes.py](app/routers/nodes/classes.py)

**Simplify `get_nodes_with_class()`:**
```python
@router.get("/classes/{class_id}/nodes")
async def get_nodes_with_class(class_id: int, user: User = Depends(get_current_user)):
    service = await _get_node_service(user)
    
    async with service._pool.acquire() as conn:
        # Get subclasses for inheritance
        subclass_ids = await extension_service.get_all_subclasses(class_id)
        all_class_ids = [class_id] + subclass_ids
        
        # Direct array query - no JOINs!
        rows = await conn.fetch("""
            SELECT * FROM node 
            WHERE class_ids && $1::integer[]  -- Array overlap operator
              AND graph_id = $2 AND active = TRUE
            ORDER BY write_date DESC
        """, all_class_ids, service._graph_id)
    
    # ... rest unchanged
```

#### 3.3 Node Response Building
- [app/routers/nodes/helpers.py](app/routers/nodes/helpers.py) - `_node_to_response()`

Already receives `classes` parameter, but we can simplify:
```python
def _node_to_response(node: Node, children=None, classes=None, ...):
    # classes can now default to node.class_ids if not provided
    return {
        ...
        "classes": classes if classes is not None else node.class_ids,
    }
```

**Estimated effort**: 2-3 hours

---

### Phase 4: Remove Property-Based Classes

#### 4.1 Remove System Property Definition
- [app/db/schema/constants.py](app/db/schema/constants.py)

**Remove from `SYSTEM_PROPERTY_UUIDS`:**
```python
# DELETE this line:
"classes": "00000000-0000-0000-0000-000000000002",
```

**Remove from `SYSTEM_PROPERTIES`:**
```python
# DELETE this entry:
{"name": "classes", "type": "node", "multi": True, "is_system": True, ...}
```

#### 4.2 Remove Frontend Constants
- [frontend/src/constants/systemProperties.ts](frontend/src/constants/systemProperties.ts)

```typescript
// REMOVE:
classes: '00000000-0000-0000-0000-000000000002',

// REMOVE function:
export function isClassesProperty(uuid: string): boolean { ... }
```

#### 4.3 Cleanup Property Exclusions
- [frontend/src/components/PropertiesSection.tsx](frontend/src/components/PropertiesSection.tsx)

```typescript
// REMOVE these checks (classes no longer a property):
if (prop.uuid === SYSTEM_PROPERTY_UUIDS.classes) continue;
```

- [frontend/src/components/TypePropertiesEditor.tsx](frontend/src/components/TypePropertiesEditor.tsx)

```typescript
// REMOVE:
if (prop.uuid === SYSTEM_PROPERTY_UUIDS.classes) return false;
```

#### 4.4 Update Backlinks Logic
- [app/routers/nodes/links.py](app/routers/nodes/links.py)

Remove the special case that excludes `classes` property from backlinks (no longer needed since classes aren't stored as property relations).

#### 4.5 Database Migration - Remove Old Data
```sql
-- Remove orphaned property_value_relation entries for classes
DELETE FROM property_value_relation 
WHERE property_id IN (SELECT id FROM property WHERE name = 'classes');

-- Remove node_property entries for classes
DELETE FROM node_property 
WHERE property_id IN (SELECT id FROM property WHERE name = 'classes');

-- Remove the classes property definition (optional - can keep for backward compatibility)
-- DELETE FROM property WHERE name = 'classes' AND is_system = TRUE;
```

**Estimated effort**: 2 hours

---

### Phase 5: Update Tests

**Files to modify:**
- [tests/test_system_types.py](tests/test_system_types.py)
- [tests/test_linked_refs.py](tests/test_linked_refs.py)

**Changes:**
1. Remove `classes_property_id` from fixtures
2. Update assertions to check `node.class_ids` instead of property relations
3. Simplify test setup (no need to create property entries)

```python
# BEFORE (complex):
await conn.execute(
    '''INSERT INTO node_property (node_id, property_id, ...) VALUES ...'''
)
await conn.execute(
    '''INSERT INTO property_value_relation (...) VALUES ...'''
)

# AFTER (simple):
await conn.execute(
    "UPDATE node SET class_ids = $1 WHERE id = $2",
    [class_id], node_id
)
```

**Estimated effort**: 2 hours

---

### Phase 6: Frontend Changes (Minimal)

The frontend **does not need significant changes** because:

1. **API contracts stay the same**: 
   - `POST /{node_id}/classes` still works
   - `DELETE /{node_id}/classes/{class_id}` still works
   - Response still includes `classes: number[]`

2. **Hooks stay the same**:
   - `useAddClass()` / `useRemoveClass()` call same endpoints
   - `useClasses()` returns same data structure

**Optional improvements:**
- Optimistic updates can now directly modify `node.classes` without roundtrip

**Estimated effort**: 0-1 hour (just verification)

---

## Summary Table

| Phase | Description | Files Changed | Effort |
|-------|-------------|---------------|--------|
| 1 | Database schema | 2 | 1h |
| 2 | Domain layer | 3 | 3-4h |
| 3 | Routers/helpers | 3 | 2-3h |
| 4 | Remove property-based | 6 | 2h |
| 5 | Update tests | 2 | 2h |
| 6 | Frontend verification | 0-2 | 0-1h |
| **Total** | | **~16 files** | **10-13h** |

---

## Rollback Plan

If issues occur:
1. Keep `classes` property definition in database (don't delete in Phase 4)
2. Migration script is additive (adds column, doesn't remove data)
3. Can revert code changes while keeping both storage mechanisms

---

## Validation Checklist

- [ ] All existing classes are migrated to `class_ids` column
- [ ] `GET /api/nodes/{id}` returns correct `classes` array
- [ ] `POST /api/nodes/{id}/classes` adds to `class_ids`
- [ ] `DELETE /api/nodes/{id}/classes/{class_id}` removes from `class_ids`
- [ ] `GET /api/classes/{id}/nodes` returns nodes with that class
- [ ] Class inheritance (`extends`) still works
- [ ] System class protections still enforced (can't add day/month/year manually)
- [ ] `is_page`, `is_class` flags still computed from classes
- [ ] Backlinks no longer show class assignments (correct behavior)
- [ ] Frontend class picker works
- [ ] NodeView shows correct classes
- [ ] All tests pass

---

## Open Questions

1. **Keep `classes` property for backward compatibility?** 
   - Pro: External integrations might use it
   - Con: Maintenance burden, confusion
   - Recommendation: Remove it

2. **Sync mechanism during transition?**
   - Option A: Big-bang migration (recommended - simpler)
   - Option B: Dual-write period (complex, error-prone)

3. **What about `classes_path`?**
   - Keep as-is (inherited classes from ancestors)
   - Computed from `class_ids` up the tree
   - No changes needed

---

## Next Steps

1. Review this plan
2. Create a feature branch: `feat/classes-as-db-field`
3. Start with Phase 1 (schema migration)
4. Proceed sequentially through phases
5. Test thoroughly after each phase
