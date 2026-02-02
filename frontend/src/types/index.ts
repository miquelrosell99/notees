/**
 * Re-export all types from the types directory
 * Note: PropertyType is exported from both api.ts and queryAST.ts
 */
export * from './api';
export * from './views';
export * from './nodeCollection';
export * from './viewModes';

// Export QueryAST types (primary)
export type {
  PropertyOperator,
  ContentOperator,
  PropertyType,
  ASTNodeType,
  QueryAST,
  ScopeNode,
  GroupNode,
  ConditionNode,
  ClassCondition,
  ContentCondition,
  PropertyCondition,
  ReferenceCondition,
  ReferencePathCondition,
  BaseConditionNode,
} from './queryAST';

// Export legacy QueryBlockTree types (backward compatibility)
export { 
  type QueryBlockType,
  type BaseQueryBlock,
  type ContainerBlock,
  type NotBlock,
  type ClassBlock,
  type PropertyBlock,
  type ContentBlock,
  type ReferenceBlock,
  type ReferencePathBlock,
  type ParentBlock,
  type ParentPathBlock,
  type ChildBlock,
  type ChildPathBlock,
  type ClassPathBlock,
  type UuidBlock,
  type QueryBlock,
  type QueryBlockTree,
  type NodeViewType,
  type NodeView,
  type NodeViewCreate,
  type NodeViewUpdate,
  type QueryExecuteRequest,
} from './query';

