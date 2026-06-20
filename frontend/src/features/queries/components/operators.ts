/**
 * Unified Operator Definitions
 * 
 * Single source of truth for all query operators across the application.
 * Uses verbose naming matching backend enums (e.g., "equals" not "=").
 * 
 * Migration note: Frontend historically used symbols ('=', '!=', etc.) but
 * backend uses verbose enum values. This file standardizes on backend naming.
 */

export interface OperatorDefinition {
  /** The actual value stored/sent to backend */
  value: string;
  /** Human-readable label shown in UI */
  label: string;
  /** Optional symbol for compact display */
  symbol?: string;
}

// ==================== Content Operators ====================

/**
 * Operators for content/text search conditions
 * Matches backend: ContentOperator enum
 */
export const CONTENT_OPERATORS: OperatorDefinition[] = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'equals', symbol: '=' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'regex', label: 'matches regex' },
  { value: 'fts', label: 'full-text search' },
];

// ==================== Property Operators ====================

/**
 * Operators for property value conditions
 * Matches backend: PropertyOperator enum
 */
export const PROPERTY_OPERATORS: OperatorDefinition[] = [
  { value: 'equals', label: 'equals', symbol: '=' },
  { value: 'not_equals', label: 'not equals', symbol: '≠' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'greater_than', label: 'greater than', symbol: '>' },
  { value: 'gte', label: 'greater than or equals', symbol: '≥' },
  { value: 'less_than', label: 'less than', symbol: '<' },
  { value: 'lte', label: 'less than or equals', symbol: '≤' },
  { value: 'in', label: 'in' },
  { value: 'not_in', label: 'not in' },
  { value: 'is_not_empty', label: 'has value' },
  { value: 'is_empty', label: 'is empty' },
];

// ==================== Class Operators ====================

/**
 * Operators for class conditions
 */
export const CLASS_OPERATORS: OperatorDefinition[] = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'does_not_contain', label: 'does not contain' },
  { value: 'defined', label: 'is defined' },
  { value: 'not_defined', label: 'is not defined' },
];

// ==================== Extends Operators ====================

/**
 * Operators for class extends conditions (inheritance)
 */
export const EXTENDS_OPERATORS: OperatorDefinition[] = [
  { value: 'extends', label: 'extends' },
];

// ==================== Reference Operators ====================

/**
 * Operators for reference/link conditions
 */
export const REFERENCE_OPERATORS: OperatorDefinition[] = [
  { value: 'references', label: 'references' },
  { value: 'does_not_reference', label: 'does not reference' },
  { value: 'has_references', label: 'is set' },
  { value: 'has_no_references', label: 'is not set' },
];

// ==================== Parent/Hierarchy Operators ====================

/**
 * Operators for parent hierarchy conditions
 */
export const PARENT_OPERATORS: OperatorDefinition[] = [
  { value: 'has_parent', label: 'is any of' },
  { value: 'not_has_parent', label: 'is not any of' },
  { value: 'has_any_parent', label: 'is set' },
  { value: 'has_no_parent', label: 'is not set' },
];

/**
 * Operators for child hierarchy conditions
 */
export const CHILD_OPERATORS: OperatorDefinition[] = [
  { value: 'has_child', label: 'contains any of' },
  { value: 'not_has_child', label: 'does not contain any of' },
  { value: 'has_any_child', label: 'is set' },
  { value: 'has_no_child', label: 'is not set' },
];

/**
 * Operators for parent path (ancestor) conditions
 */
export const PARENT_PATH_OPERATORS: OperatorDefinition[] = [
  { value: 'has_ancestor', label: 'includes' },
  { value: 'not_has_ancestor', label: 'does not include' },
  { value: 'has_any_ancestor', label: 'is set' },
  { value: 'has_no_ancestor', label: 'is not set' },
];

/**
 * Operators for child path (descendant) conditions
 */
export const CHILD_PATH_OPERATORS: OperatorDefinition[] = [
  { value: 'has_descendant', label: 'contains' },
  { value: 'not_has_descendant', label: 'does not contain' },
  { value: 'has_any_descendant', label: 'is set' },
  { value: 'has_no_descendant', label: 'is not set' },
];

// ==================== Flag Operators ====================

/**
 * Operators for node flag conditions (is_page, is_day, etc.)
 */
export const FLAG_OPERATORS: OperatorDefinition[] = [
  { value: 'is_true', label: 'is true' },
  { value: 'is_false', label: 'is false' },
];

// ==================== Page Operators ====================

/**
 * Operators for page (containing page) conditions
 */
export const PAGE_OPERATORS: OperatorDefinition[] = [
  { value: 'is_page', label: 'is any of' },
  { value: 'is_not_page', label: 'is not any of' },
  { value: 'has_any_page', label: 'is set' },
  { value: 'has_no_page', label: 'is not set' },
];

// ==================== Tag Operators ====================

/**
 * Operators for tag conditions
 */
export const TAG_OPERATORS: OperatorDefinition[] = [
  { value: 'is', label: 'is any of' },
  { value: 'is_not', label: 'is not any of' },
  { value: 'has_any_tag', label: 'is set' },
  { value: 'has_no_tag', label: 'is not set' },
];

// ==================== Style Operators ====================

/**
 * Operators for style/formatting conditions (bold, italic, etc.)
 */
export const STYLE_OPERATORS: OperatorDefinition[] = [
  { value: 'contains', label: 'contains' },
  { value: 'does_not_contain', label: 'does not contain' },
  { value: 'is', label: 'is entirely' },
  { value: 'is_not', label: 'is not entirely' },
];

// ==================== Operator Maps ====================

/**
 * Map from operator value to definition for quick lookup
 */
export const OPERATOR_MAP = new Map<string, OperatorDefinition>(
  [
    ...CONTENT_OPERATORS,
    ...PROPERTY_OPERATORS,
    ...CLASS_OPERATORS,
    ...REFERENCE_OPERATORS,
    ...PARENT_OPERATORS,
    ...CHILD_OPERATORS,
    ...FLAG_OPERATORS,
    ...STYLE_OPERATORS,
    ...PAGE_OPERATORS,
    ...TAG_OPERATORS,
  ].map(op => [op.value, op])
);

/**
 * Get operator definition by value, with fallback
 */
export function getOperatorDefinition(value: string): OperatorDefinition {
  return OPERATOR_MAP.get(value) ?? { value, label: value };
}
