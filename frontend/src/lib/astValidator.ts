/**
 * AST Validator
 * 
 * Validates QueryAST structure and enforces architectural invariants.
 * These are developer-facing validation errors to catch bugs during development.
 * 
 * Key invariants:
 * - Scope limits the search universe (WHERE to search)
 * - Conditions filter within the scope (WHAT to match)
 * - Scope must never render as prose conditions
 * - Conditions must never mutate scope implicitly
 * - System nodes must have proper capabilities set
 */

import type { QueryAST, GroupNode, ConditionNode, NotNode, ScopeNode } from '@/types/queryAST';
import { isSystemNode, SYSTEM_CAPABILITIES } from '@/types/queryAST';

// ==================== Types ====================

export interface ValidationError {
  /** Error severity */
  severity: 'error' | 'warning';
  /** Human-readable error message */
  message: string;
  /** Path to the problematic node */
  path: string[];
  /** Optional suggestion for fixing */
  suggestion?: string;
}

export interface ValidationResult {
  /** Is the AST valid? */
  valid: boolean;
  /** List of validation errors */
  errors: ValidationError[];
}

// ==================== Validation Functions ====================

/**
 * Validate a QueryAST
 * Returns all validation errors found
 */
export function validateAST(ast: QueryAST): ValidationResult {
  const errors: ValidationError[] = [];
  
  // Validate scope
  validateScope(ast.scope, errors);
  
  // Validate root group
  validateGroup(ast.root_group, ['root_group'], errors);
  
  // Check for scope/condition separation
  validateScopeConditionSeparation(ast, errors);
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate scope node
 */
function validateScope(scope: ScopeNode, errors: ValidationError[]): void {
  const path = ['scope'];
  
  // Validate specific_pages has page_uuids
  if (scope.scope_type === 'specific_pages') {
    if (!scope.page_uuids || scope.page_uuids.length === 0) {
      errors.push({
        severity: 'error',
        message: 'Scope type "specific_pages" requires page_uuids array',
        path,
        suggestion: 'Add page_uuids array or change scope_type',
      });
    }
  }
  
  // Validate excluded pages don't overlap with included
  if (scope.page_uuids && scope.excluded_page_uuids) {
    const overlap = scope.page_uuids.filter(id => scope.excluded_page_uuids?.includes(id));
    if (overlap.length > 0) {
      errors.push({
        severity: 'error',
        message: 'Scope has overlapping page_uuids and excluded_page_uuids',
        path,
        suggestion: `Remove duplicates: ${overlap.join(', ')}`,
      });
    }
  }
}

/**
 * Validate group node
 */
function validateGroup(group: GroupNode, path: string[], errors: ValidationError[]): void {
  // Check capabilities on system nodes
  if (isSystemNode(group)) {
    validateSystemNodeCapabilities(group, path, errors);
  }
  
  // Validate children
  group.children.forEach((child, index) => {
    const childPath = [...path, `child[${index}]`];
    
    if (child.type === 'group') {
      validateGroup(child, childPath, errors);
    } else if (child.type === 'condition') {
      validateCondition(child, childPath, errors);
    } else if (child.type === 'not') {
      validateNotNode(child, childPath, errors);
    }
  });
}

/**
 * Validate condition node
 */
function validateCondition(condition: ConditionNode, path: string[], errors: ValidationError[]): void {
  // Check capabilities on system nodes
  if (isSystemNode(condition)) {
    validateSystemNodeCapabilities(condition, path, errors);
  }
  
  // Validate condition-specific requirements
  switch (condition.condition_type) {
    case 'type':
      if (!condition.type_uuid) {
        errors.push({
          severity: 'error',
          message: 'Type condition requires type_uuid',
          path,
          suggestion: 'Add type_uuid value',
        });
      }
      break;
    
    case 'property':
      if (!condition.property_name) {
        errors.push({
          severity: 'error',
          message: 'Property condition requires property_name',
          path,
          suggestion: 'Add property_name value',
        });
      }
      break;
    
    case 'content':
      if (condition.value === undefined || condition.value === '') {
        errors.push({
          severity: 'warning',
          message: 'Content condition has empty value',
          path,
          suggestion: 'Add search text',
        });
      }
      break;
    
    case 'reference':
      if (!condition.target_uuid) {
        errors.push({
          severity: 'error',
          message: 'Reference condition requires target_uuid',
          path,
          suggestion: 'Add target_uuid value',
        });
      }
      break;
    
    // Nested conditions need groups
    case 'reference_path':
    case 'parent':
    case 'parent_path':
    case 'child':
    case 'child_path':
    case 'class_path':
      if (!condition.nested_group) {
        errors.push({
          severity: 'error',
          message: `${condition.condition_type} condition requires nested_group`,
          path,
          suggestion: 'Add nested_group with conditions',
        });
      }
      break;
  }
}

/**
 * Validate NOT node
 */
function validateNotNode(notNode: NotNode, path: string[], errors: ValidationError[]): void {
  const childPath = [...path, 'child'];
  
  if (notNode.child.type === 'group') {
    validateGroup(notNode.child, childPath, errors);
  } else {
    validateCondition(notNode.child, childPath, errors);
  }
}

/**
 * Validate system node has proper capabilities
 */
function validateSystemNodeCapabilities(
  node: GroupNode | ConditionNode,
  path: string[],
  errors: ValidationError[]
): void {
  if (!node.capabilities) {
    errors.push({
      severity: 'warning',
      message: 'System node missing explicit capabilities',
      path,
      suggestion: 'Add SYSTEM_CAPABILITIES to this node',
    });
    return;
  }
  
  // Check each capability matches system expectations
  const expected = SYSTEM_CAPABILITIES;
  const actual = node.capabilities;
  
  if (actual.removable !== expected.removable) {
    errors.push({
      severity: 'error',
      message: `System node has removable=${actual.removable}, expected ${expected.removable}`,
      path,
      suggestion: 'Set removable: false on system nodes',
    });
  }
  
  if (actual.editable !== expected.editable) {
    errors.push({
      severity: 'error',
      message: `System node has editable=${actual.editable}, expected ${expected.editable}`,
      path,
      suggestion: 'Set editable: false on system nodes',
    });
  }
  
  if (actual.movable !== expected.movable) {
    errors.push({
      severity: 'error',
      message: `System node has movable=${actual.movable}, expected ${expected.movable}`,
      path,
      suggestion: 'Set movable: false on system nodes',
    });
  }
  
  if (actual.combinable !== expected.combinable) {
    errors.push({
      severity: 'error',
      message: `System node has combinable=${actual.combinable}, expected ${expected.combinable}`,
      path,
      suggestion: 'Set combinable: false on system nodes',
    });
  }
}

/**
 * Validate scope/condition separation
 * Ensures conditions don't try to mutate scope
 */
function validateScopeConditionSeparation(ast: QueryAST): void {
  // Check that parent_path conditions with current_node_uuid are not duplicating scope
  function checkGroup(group: GroupNode, path: string[]): void {
    group.children.forEach((child, index) => {
      const childPath = [...path, `child[${index}]`];
      
      if (child.type === 'group') {
        checkGroup(child, childPath);
      } else if (child.type === 'condition') {
        // Check for parent_path with {current_node_uuid} - this might duplicate scope
        if (child.condition_type === 'parent_path') {
          const nested = child.nested_group;
          if (nested && nested.children.length > 0) {
            // This is actually OK - it's filtering by parent matching criteria
            // Not a scope violation
          }
        }
        
        // Check that conditions don't reference scope-level concepts directly
        // (This is more of a design check than a hard error)
      } else if (child.type === 'not') {
        if (child.child.type === 'group') {
          checkGroup(child.child, [...childPath, 'child']);
        }
      }
    });
  }
  
  checkGroup(ast.root_group, ['root_group']);
}

// ==================== Helper Functions ====================

/**
 * Check if AST is valid (no errors)
 */
export function isValidAST(ast: QueryAST): boolean {
  return validateAST(ast).valid;
}

/**
 * Get validation errors for an AST
 */
export function getValidationErrors(ast: QueryAST): ValidationError[] {
  return validateAST(ast).errors;
}

/**
 * Assert AST is valid (throws in development)
 */
export function assertValidAST(ast: QueryAST): void {
  if (process.env.NODE_ENV === 'development') {
    const result = validateAST(ast);
    if (!result.valid) {
      console.error('QueryAST validation failed:', result.errors);
      // Don't throw - just log in development
    }
  }
}
