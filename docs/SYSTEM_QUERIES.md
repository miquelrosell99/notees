# System Queries

## Overview

System queries are **read-only queries** that are automatically generated for specific features in Notees. They cannot be modified by users through the query builder UI or API.

## Purpose

System queries serve features like:
- **Linked References**: Show all pages that link to the current page
- **Child Pages**: Show all direct children of a page
- **Classed Nodes**: Show all nodes with a specific type/tag
- **Unlinked References**: Show pages that mention the page name without explicit links
- **Recent Changes**: Show recently modified pages

## Implementation

### Data Structure

System queries are identified by the `is_system` flag in the QueryAST:

```typescript
interface QueryAST {
  type: 'query';
  version: '1.0';
  scope: ScopeNode;
  root_group: GroupNode;
  is_system?: boolean;  // ← System query flag
  // ... other fields
}
```

### Frontend Protection

The frontend prevents modification of system queries in multiple ways:

1. **QueryBuilder Component**: Displays a banner and disables all controls when `is_system` is true
2. **Component Props**: All query components respect the `readOnly` prop
3. **Helper Functions**: `isSystemQuery()` checks if a query is system-generated

### Backend Protection

The backend enforces system query immutability:

1. **Validation**: `validate_query_ast()` returns an error if attempting to modify a system query
2. **API Endpoints**: Both create and update endpoints reject system queries
3. **HTTP Status**: Returns `403 Forbidden` with a descriptive error message

### Creating System Queries

Use the factory functions in `frontend/src/lib/systemQueries.ts`:

```typescript
import { createLinkedReferencesQuery } from '@/lib/systemQueries';

// Create a linked references query for a specific page
const query = createLinkedReferencesQuery(pageUuid);

// The query is automatically marked as system
console.log(query.is_system); // true
```

Available factory functions:
- `createLinkedReferencesQuery(pageUuid)` - Incoming references to a page
- `createChildPagesQuery(parentUuid)` - Direct children of a page
- `createClassedNodesQuery(typeUuid, typeName?)` - Pages with a specific type
- `createUnlinkedReferencesQuery(pageName)` - Mentions without links
- `createRecentChangesQuery(daysBack?)` - Recently modified pages

## API Behavior

### Creating System Queries

❌ **Cannot create via API**:
```http
POST /api/nodes/views
{
  "query_ast": {
    "type": "query",
    "is_system": true,  // ← Will be rejected
    ...
  }
}
```

Response: `403 Forbidden - Cannot create system queries through this endpoint`

✅ **Must be created internally** by the application code.

### Updating System Queries

❌ **Cannot update via API**:
```http
PUT /api/nodes/views/123/query-ast
{
  "query_ast": { ... }  // If existing query is system, this fails
}
```

Response: `403 Forbidden - Cannot modify system query. System queries (linked references, child pages, etc.) are read-only.`

### Validation

The validation service explicitly checks for system queries:

```python
from app.domain.services.query_ast_validation import validate_query_ast, can_save_query

# Validate with system query protection (default)
result = validate_query_ast(ast, allow_system_modification=False)

# Check if query can be saved
can_save, reason = can_save_query(ast, allow_system_modification=False)
if not can_save:
    print(reason)  # "Cannot modify system query"
```

## UI Behavior

### System Query Banner

When a system query is displayed in QueryBuilder, a banner appears:

```
🔒 System Query
This query is generated automatically (e.g., linked references, child pages) and cannot be modified.
```

### Disabled Controls

All interactive elements are disabled:
- Scope selector buttons
- Logic operator toggles (AND/OR)
- Add Filter buttons
- Add Group buttons
- Remove buttons
- All input fields and dropdowns

## Database Storage

System queries are stored in the `node_views` table like regular queries:

```sql
-- node_views table
CREATE TABLE node_views (
  id SERIAL PRIMARY KEY,
  node_id UUID NOT NULL,
  view_name VARCHAR(255),
  query_json JSONB,  -- ← Contains QueryAST with is_system flag
  ...
);
```

Example stored query:
```json
{
  "type": "query",
  "version": "1.0",
  "is_system": true,
  "description": "Linked References",
  "scope": {
    "type": "scope",
    "scope_type": "entire_graph"
  },
  "root_group": {
    "type": "group",
    "logic": "AND",
    "children": [
      {
        "type": "condition",
        "condition_type": "reference",
        "target_uuid": "abc-123",
        "direction": "incoming"
      }
    ]
  }
}
```

## Security Considerations

### Why System Queries Are Protected

1. **Data Integrity**: System queries represent core functionality (linked refs, hierarchy)
2. **User Expectations**: Users expect these features to work consistently
3. **Performance**: System queries may be optimized differently than user queries
4. **Semantic Meaning**: Modifying a "Linked References" query would break its purpose

### Bypassing Protection (Internal Use Only)

In rare cases where internal code needs to modify system queries:

```python
# Python backend - use with extreme caution
result = validate_query_ast(
    ast,
    allow_system_modification=True  # ⚠️ Only for internal operations
)
```

This should **never** be exposed to user-facing endpoints.

## Testing

### Frontend Tests

```typescript
import { isSystemQuery } from '@/lib/queryASTHelpers';
import { createLinkedReferencesQuery } from '@/lib/systemQueries';

test('identifies system queries', () => {
  const query = createLinkedReferencesQuery('page-123');
  expect(isSystemQuery(query)).toBe(true);
});

test('user queries are not system queries', () => {
  const query = createDefaultQueryAST();
  expect(isSystemQuery(query)).toBe(false);
});
```

### Backend Tests

```python
from app.domain.entities.query_ast import QueryAST
from app.domain.services.query_ast_validation import validate_query_ast

def test_system_query_protection():
    ast = QueryAST(is_system=True, ...)
    result = validate_query_ast(ast, allow_system_modification=False)
    
    assert not result.valid
    assert any(
        issue.message == 'Cannot modify system query'
        for issue in result.issues
    )
```

### API Tests

```python
async def test_cannot_create_system_query(authenticated_client):
    response = await authenticated_client.post(
        "/api/nodes/views",
        json={
            "node_id": "page-123",
            "query_ast": {
                "type": "query",
                "version": "1.0",
                "is_system": True,
                ...
            }
        }
    )
    assert response.status_code == 403
    assert "Cannot create system queries" in response.json()["detail"]
```

## Future Enhancements

Potential improvements to the system query feature:

1. **Query Templates**: Allow users to create queries based on system query patterns
2. **Query Forking**: Let users "fork" a system query into an editable copy
3. **System Query Registry**: Centralized registry of all system query types
4. **Permissions**: Granular control over which system queries are visible
5. **Custom System Queries**: Plugin API for extensions to define system queries

## Related Files

### Frontend
- `frontend/src/types/queryAST.ts` - QueryAST type definition with `is_system` flag
- `frontend/src/lib/queryASTHelpers.ts` - `isSystemQuery()` helper
- `frontend/src/lib/systemQueries.ts` - System query factory functions
- `frontend/src/components/queries/QueryBuilder.tsx` - System query banner and UI
- `frontend/src/components/queries/QueryBuilder.css` - Banner styling

### Backend
- `app/domain/entities/query_ast.py` - QueryAST dataclass with `is_system` field
- `app/domain/services/query_ast_validation.py` - System query validation
- `app/routers/nodes/views.py` - API endpoint protection

## Summary

System queries provide a secure, read-only mechanism for core Notees features. They are:
- ✅ Automatically generated by application code
- ✅ Clearly marked in the UI with a banner
- ✅ Protected from modification at API and validation layers
- ✅ Stored alongside user queries in the database
- ❌ Cannot be created or modified through public endpoints
- ❌ Cannot be edited in the QueryBuilder UI
