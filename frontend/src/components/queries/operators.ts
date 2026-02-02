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
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'equals', label: 'equals', symbol: '=' },
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
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'has value' },
  { value: 'in', label: 'in' },
  { value: 'not_in', label: 'not in' },
];

// ==================== Class/Type Operators ====================

/**
 * Operators for type/class conditions
 */
export const CLASS_OPERATORS: OperatorDefinition[] = [
  { value: 'contains', label: 'contains' },
  { value: 'does_not_contain', label: 'does not contain' },
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'defined', label: 'is defined' },
  { value: 'not_defined', label: 'is not defined' },
];

// ==================== Reference Operators ====================

/**
 * Operators for reference/link conditions
 */
export const REFERENCE_OPERATORS: OperatorDefinition[] = [
  { value: 'references', label: 'references' },
  { value: 'does_not_reference', label: 'does not reference' },
  { value: 'has_references', label: 'has any references' },
  { value: 'has_no_references', label: 'has no references' },
];

// ==================== Parent/Hierarchy Operators ====================

/**
 * Operators for parent hierarchy conditions
 */
export const PARENT_OPERATORS: OperatorDefinition[] = [
  { value: 'has_parent', label: 'is' },
  { value: 'has_no_parent', label: 'is not set' },
];

/**
 * Operators for child hierarchy conditions
 */
export const CHILD_OPERATORS: OperatorDefinition[] = [
  { value: 'has_child', label: 'has child' },
  { value: 'has_no_child', label: 'has no child' },
];

// ==================== Flag Operators ====================

/**
 * Operators for node flag conditions (is_page, is_day, etc.)
 */
export const FLAG_OPERATORS: OperatorDefinition[] = [
  { value: 'is_true', label: 'is true' },
  { value: 'is_false', label: 'is false' },
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
  ].map(op => [op.value, op])
);

/**
 * Get operator definition by value, with fallback
 */
export function getOperatorDefinition(value: string): OperatorDefinition {
  return OPERATOR_MAP.get(value) ?? { value, label: value };
}

// ==================== Legacy Symbol Mapping ====================

/**
 * Map from legacy symbols ('=', '!=', etc.) to new verbose values
 * Use this for backward compatibility during migration
 */
export const LEGACY_OPERATOR_MAP: Record<string, string> = {
  '=': 'equals',
  '!=': 'not_equals',
  '>': 'greater_than',
  '>=': 'gte',
  '<': 'less_than',
  '<=': 'lte',
  'matches_regex': 'regex',
};

/**
 * Normalize operator value from legacy symbol to verbose name
 */
export function normalizeOperator(operator: string): string {
  return LEGACY_OPERATOR_MAP[operator] ?? operator;
}
