# Query AST Quick Reference

## Import What You Need

```typescript
// Types
import type { QueryAST, GroupNode, ConditionNode, ValidationResult } from '@/types/queryAST';
import type { QueryBlockTree } from '@/types/query';

// Converters
import { blockTreeToAST, astToBlockTree } from '@/lib/queryConverter';

// Validation
import { validateQueryAST, canSaveQuery, getValidationSummary } from '@/lib/queryValidation';

// Helpers
import { createEmptyQueryAST, countConditions, getMaxDepth } from '@/types/queryAST';
```

## Common Patterns

### Load and Convert
```typescript
// From backend QueryBlockTree
const blockTree = view.query_block_tree;
const queryId = `view-${view.id}`;
const ast = blockTreeToAST(blockTree, queryId);
```

### Validate
```typescript
const validation = validateQueryAST(ast);

if (validation.valid) {
  // Good to go
} else {
  // Check issues
  validation.issues.forEach(issue => {
    console.log(`${issue.severity}: ${issue.message}`);
    if (issue.suggestion) {
      console.log(`Suggestion: ${issue.suggestion}`);
    }
  });
}
```

### Update and Revalidate
```typescript
// Modify AST
const updatedAST = {
  ...ast,
  root_group: {
    ...ast.root_group,
    logic: 'OR',
  },
};

// Always revalidate after changes
setAST(updatedAST);
setValidation(validateQueryAST(updatedAST));
```

### Save
```typescript
// Check before saving
if (!canSaveQuery(validation)) {
  alert(getValidationSummary(validation));
  return;
}

// Convert back to BlockTree
const blockTree = astToBlockTree(ast);
await api.saveQuery(blockTree);
```

## AST Structure

```typescript
{
  type: 'query',
  version: '1.0',
  id: 'view-123-abc',
  created_at: '2026-01-26T10:00:00Z',
  updated_at: '2026-01-26T11:30:00Z',
  
  scope: {
    type: 'scope',
    scope_type: 'specific_pages',
    page_uuids: ['page1-uuid', 'page2-uuid'],
    include_descendants: true,
  },
  
  root_group: {
    type: 'group',
    logic: 'AND',
    children: [
      {
        type: 'condition',
        condition_type: 'content',
        operator: 'contains',
        value: 'hello',
      },
      {
        type: 'group',
        logic: 'OR',
        children: [/* nested */],
      },
    ],
  },
}
```

## Validation Severities

- **error**: Blocks saving, must be fixed
- **warning**: Allowed but not recommended
- **info**: Suggestions for improvement

## Creating Nodes

```typescript
import {
  createEmptyQueryAST,
  createScopeNode,
  createGroupNode,
  createTypeCondition,
  createPropertyCondition,
  createContentCondition,
} from '@/types/queryAST';

// New query
const ast = createEmptyQueryAST();

// New group
const group = createGroupNode('AND');

// New condition
const condition = createContentCondition('contains', 'search term');
```

## Checking Query State

```typescript
import { isEmptyQuery, countConditions, getMaxDepth } from '@/types/queryAST';

if (isEmptyQuery(ast)) {
  console.log('No conditions');
}

console.log(`${countConditions(ast)} conditions`);
console.log(`${getMaxDepth(ast)} levels deep`);
```

## SQL Preview

```typescript
import { QuerySQLPreview } from '@/components/queries';

<QuerySQLPreview 
  ast={ast} 
  disabled={validation && !canSaveQuery(validation)}
/>
```

## Common Pitfalls

### ❌ Don't Forget to Revalidate
```typescript
// BAD
setAST({ ...ast, root_group: newGroup });
// Validation is now stale!
```

```typescript
// GOOD
const updated = { ...ast, root_group: newGroup };
setAST(updated);
setValidation(validateQueryAST(updated));
```

### ❌ Don't Skip Validation Check Before Save
```typescript
// BAD
await api.save(astToBlockTree(ast));
```

```typescript
// GOOD
const validation = validateQueryAST(ast);
if (!canSaveQuery(validation)) return;
await api.save(astToBlockTree(ast));
```

### ❌ Don't Mutate AST Directly
```typescript
// BAD
ast.root_group.logic = 'OR';
setAST(ast); // Won't trigger re-render!
```

```typescript
// GOOD
setAST({
  ...ast,
  root_group: { ...ast.root_group, logic: 'OR' },
});
```

## Debugging

```typescript
// Log AST structure
console.log('AST:', JSON.stringify(ast, null, 2));

// Check validation
const validation = validateQueryAST(ast);
console.log('Valid?', validation.valid);
console.log('Issues:', validation.issues);

// Count things
console.log('Conditions:', countConditions(ast));
console.log('Max depth:', getMaxDepth(ast));

// Test round-trip
const blockTree = astToBlockTree(ast);
const ast2 = blockTreeToAST(blockTree);
console.log('Round-trip equal?', JSON.stringify(ast) === JSON.stringify(ast2));
```

## Performance Tips

1. **Batch Updates**: Update AST once, validate once
2. **Memoize Validation**: Only revalidate when AST changes
3. **Debounce UI**: Wait for user to stop typing before validating
4. **Lazy SQL Preview**: Only generate when expanded

## TypeScript Tips

```typescript
// Type guard for groups
if (node.type === 'group') {
  const group = node as GroupNode;
  // Now you have full GroupNode type
}

// Type guard for conditions
if (child.type === 'condition') {
  const condition = child as ConditionNode;
  
  // Further narrow by condition_type
  if (condition.condition_type === 'content') {
    const contentCond = condition as ContentCondition;
    console.log(contentCond.value); // Fully typed
  }
}
```

## When to Use What

| Task | Use This |
|------|----------|
| Load query | `blockTreeToAST(tree, id)` |
| Save query | `astToBlockTree(ast)` |
| Validate | `validateQueryAST(ast)` |
| Check if can save | `canSaveQuery(validation)` |
| Get error summary | `getValidationSummary(validation)` |
| Create new query | `createEmptyQueryAST()` |
| Count conditions | `countConditions(ast)` |
| Check if empty | `isEmptyQuery(ast)` |

## State Management Pattern

```typescript
const [ast, setAST] = useState<QueryAST | null>(null);
const [validation, setValidation] = useState<ValidationResult | null>(null);

// On load
useEffect(() => {
  const loaded = blockTreeToAST(blockTree, queryId);
  setAST(loaded);
  setValidation(validateQueryAST(loaded));
}, [blockTree, queryId]);

// On change
const handleUpdate = (updated: QueryAST) => {
  setAST(updated);
  setValidation(validateQueryAST(updated));
};

// On save
const handleSave = async () => {
  if (!ast || !canSaveQuery(validation)) return;
  await api.save(astToBlockTree(ast));
};
```

## That's It!

The AST system is straightforward:
1. Load → Convert to AST
2. Edit → Update AST, Validate
3. Save → Convert to BlockTree

Everything else is just helper functions to make this easier.
