# Query AST Architecture - Implementation Summary

## Overview

This document describes the new Query AST (Abstract Syntax Tree) architecture implemented for the Notees query system. The AST provides a clean, extensible foundation for building complex queries while maintaining backward compatibility with existing QueryBlockTree format.

## Architecture Principles

**The UI is a projection of the query. The AST is the query.**

- AST is the single source of truth
- UI renders from AST state
- No semantics encoded in UI components or SQL strings
- Full bidirectional compatibility with legacy QueryBlockTree format

## Components Delivered

### 1. AST Schema (`types/queryAST.ts`)

Comprehensive type definitions for the query AST:

#### Core Node Types
- **QueryAST** - Root query structure with version, scope, and root_group
- **ScopeNode** - Defines the universe of nodes to query
  - Types: `entire_graph`, `current_page`, `specific_pages`, `linked_refs`
  - Supports included/excluded pages
  - Configurable descendants inclusion
- **GroupNode** - Boolean logic container (AND/OR)
  - Can contain conditions, other groups, and NOT nodes
  - Supports arbitrary nesting depth
- **ConditionNode** - Leaf nodes representing filters
  - Types: type, property, content, reference, reference_path, ancestor_path
  - Each has specific validation requirements
- **NotNode** - Negation wrapper for conditions or groups

#### Validation Types
- **ValidationResult** - Contains validity flag and list of issues
- **ValidationIssue** - Structured error/warning/info messages with:
  - Severity levels
  - Human-readable messages
  - Path to problematic node
  - Actionable suggestions

#### Helper Functions
- Factory functions for creating nodes
- Utility functions for counting conditions
- Depth calculation for nested groups
- Empty query detection

### 2. AST Converters (`lib/queryConverter.ts`)

Bidirectional conversion between QueryBlockTree (legacy) and QueryAST (new):

#### BlockTree → AST (`blockTreeToAST`)
- Extracts scope from ANCESTOR_PATH and NOT(ANCESTOR_PATH) blocks
- Converts remaining blocks to conditions
- Preserves AND/OR logic
- Handles nested containers

#### AST → BlockTree (`astToBlockTree`)
- Converts scope back to ANCESTOR_PATH blocks
- Maintains backend compatibility
- Preserves all query semantics
- **Zero breaking changes** to existing queries

Key design decisions:
- Scope extraction is non-destructive
- Placeholders like `{current_node_uuid}` are preserved
- System blocks are handled separately from user blocks

### 3. Query Validation (`lib/queryValidation.ts`)

Comprehensive AST-level validation:

#### Validation Rules

**Scope Validation**
- Specific pages scope must have at least one page
- No duplicate pages
- No contradictory inclusions/exclusions

**Group Validation**
- Empty groups → warning
- Single-child groups → info (redundant)
- Recursive validation of nested groups
- Contradiction detection in AND groups

**Condition Validation**
- Type conditions require type_uuid
- Property conditions require property_name and value (except is_empty/is_not_empty)
- Content conditions require search term
- Reference conditions require target_uuid
- Nested groups validated recursively

**Contradiction Detection**
- Duplicate conditions
- Impossible AND combinations (e.g., content = "A" AND content = "B")

#### Validation API
```typescript
validateQueryAST(ast: QueryAST): ValidationResult
getValidationSummary(result: ValidationResult): string
canSaveQuery(result: ValidationResult): boolean
```

### 4. SQL Preview Component (`components/queries/QuerySQLPreview.tsx`)

Read-only SQL preview for educational purposes:

#### Features
- Collapsed by default (progressive disclosure)
- Generates SQL-like pseudocode from AST
- Clearly labeled as non-executable
- Shows query structure in familiar SQL syntax
- Helps users understand the query model

#### SQL Generation
- Scope → FROM/WHERE clauses
- Groups → nested parentheses with AND/OR
- Conditions → WHERE predicates
- NOT nodes → NOT (...) wrapping
- Proper indentation for readability

## Integration Points

### Current Status

**✅ Completed:**
1. AST schema definition with full TypeScript types
2. Bidirectional converters (QueryBlockTree ↔ QueryAST)
3. Comprehensive validation system
4. SQL preview component

**🚧 Next Steps (Not Yet Implemented):**
1. Nested group UI components
2. Update QueryBlockBuilder to use AST internally
3. Refactor QuickPageFilter to work with ScopeNode
4. Add inline validation messages to UI
5. Disable Save button when validation fails
6. Add "Add Group" button to query builder
7. Visual nesting/indentation for groups
8. Query identity (IDs, versioning metadata)

### How to Integrate

#### Step 1: Convert on Load
```typescript
import { blockTreeToAST } from '@/lib/queryConverter';

const ast = blockTreeToAST(view.query_block_tree);
```

#### Step 2: Work with AST Internally
```typescript
// All modifications happen on AST
const updatedAST = {
  ...ast,
  root_group: {
    ...ast.root_group,
    children: [...ast.root_group.children, newCondition],
  },
};
```

#### Step 3: Validate Before Save
```typescript
import { validateQueryAST, canSaveQuery } from '@/lib/queryValidation';

const validation = validateQueryAST(ast);
if (!canSaveQuery(validation)) {
  // Show validation errors, disable save
  return;
}
```

#### Step 4: Convert Back for Backend
```typescript
import { astToBlockTree } from '@/lib/queryConverter';

const blockTree = astToBlockTree(ast);
await saveQueryBlockTree(blockTree); // Existing API
```

## Backward Compatibility

**100% Non-Breaking:**
- All existing queries continue to work
- Backend API unchanged
- QueryBlockTree format preserved for persistence
- AST is internal only (no schema migration required)

## Future Extensions

The AST architecture enables:

### Nested Groups (Ready to Implement)
- GroupNode already supports children
- UI just needs recursive rendering
- Validation already handles nesting

### Query as Nodes
- `id` field already in QueryAST
- Can be treated as first-class entities
- Reusable across multiple views

### Query Diffing/Versioning
- AST is serializable JSON
- Structural diffs are straightforward
- Version field supports migration

### Advanced Scope Types
- ScopeNode is extensible
- Can add: tags, types, date ranges
- No breaking changes to existing scopes

### Query Optimization
- AST enables analysis
- Can detect redundant conditions
- Can reorder for performance

### Visual Query Editor
- Graph-based representation
- Drag-and-drop nodes
- Same AST underneath

## Testing Strategy

### Unit Tests Needed
1. AST converters (bidirectional)
2. Validation rules
3. SQL generation
4. Helper functions

### Integration Tests Needed
1. Load existing query → convert → validate → save
2. Create new query → validate → convert → save
3. Invalid queries → validation errors → save disabled

### Edge Cases to Test
1. Empty queries
2. Deeply nested groups (5+ levels)
3. Contradictory conditions
4. Placeholder values
5. System blocks preservation

## Performance Considerations

- AST validation is fast (synchronous, no API calls)
- Conversion is O(n) where n = number of blocks
- SQL generation is lightweight (string building only)
- No performance regressions expected

## Documentation for Developers

### Adding a New Condition Type

1. Add type to `ConditionType` in `queryAST.ts`
2. Create interface extending `BaseConditionNode`
3. Add to `ConditionNode` union type
4. Update `convertBlockToASTNode` in `queryConverter.ts`
5. Update `convertASTNodeToBlock` in `queryConverter.ts`
6. Add validation in `validateCondition` in `queryValidation.ts`
7. Add SQL generation in `generateConditionSQL`

### Adding a New Scope Type

1. Add type to `ScopeType` in `queryAST.ts`
2. Update `ScopeNode` interface with new fields
3. Update `validateScope` in `queryValidation.ts`
4. Update `generateScopeSQL` in `QuerySQLPreview.tsx`
5. Update UI scope selector component

## Summary

This AST architecture provides:

✅ Clean separation of concerns
✅ Full backward compatibility  
✅ Extensibility for future features
✅ Robust validation
✅ Educational SQL preview
✅ Foundation for nested groups
✅ Preparation for query identity

**The query system is now architecturally ready for advanced features while maintaining stability for existing users.**
