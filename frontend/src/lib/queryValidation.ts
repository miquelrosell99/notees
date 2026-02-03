/**
 * Query AST Validation
 * 
 * Validates query ASTs and provides actionable error messages.
 */

import type {
  QueryAST,
  GroupNode,
  ConditionNode,
  NotNode as ASTNotNode,
  ValidationResult,
  ValidationIssue,
} from '../types/queryAST';

// ==================== Validation Functions ====================

/**
 * Validate a query AST
 */
export function validateQueryAST(ast: QueryAST): ValidationResult {
  const issues: ValidationIssue[] = [];
  
  // Validate scope
  validateScope(ast, issues);
  
  // Validate root group
  validateGroup(ast.root_group, ['root_group'], issues);
  
  // Check for empty query (with safety check) - silently allowed
  // const hasChildren = Array.isArray(ast.root_group.children) && ast.root_group.children.length > 0;
  
  return {
    valid: !issues.some(issue => issue.severity === 'error'),
    issues,
  };
}

/**
 * Validate scope node
 */
function validateScope(ast: QueryAST, issues: ValidationIssue[]): void {
  const scope = ast.scope;
  
  // Note: excluded_page_uuids validation could be added here if needed in the future
  // Currently, scope types are simple (entire_graph, pages, current_page) with no complex validation
}

/**
 * Validate a group node
 */
function validateGroup(group: GroupNode, path: string[], issues: ValidationIssue[]): void {
  // Safety check for children array
  if (!Array.isArray(group.children)) {
    issues.push({
      severity: 'error',
      message: 'Group must have a children array',
      path,
      suggestion: 'Ensure the group has a valid children array',
    });
    return;
  }
  
  // Empty group - silently allowed
  if (group.children.length === 0) {
    return;
  }
  
  // Single-child AND/OR group is redundant
  if (group.children.length === 1) {
    issues.push({
      severity: 'info',
      message: `${group.logic} group with only one condition is redundant`,
      path,
      suggestion: 'Consider removing the group wrapper',
    });
  }
  
  // Validate children recursively
  group.children.forEach((child, index) => {
    const childPath = [...path, 'children', String(index)];
    
    if (child.type === 'group') {
      validateGroup(child, childPath, issues);
    } else if (child.type === 'not') {
      validateNot(child, childPath, issues);
    } else if (child.type === 'condition') {
      validateCondition(child, childPath, issues);
    }
  });
  
  // Check for contradictory conditions (e.g., name = "X" AND name = "Y")
  detectContradictions(group, path, issues);
}

/**
 * Validate a NOT node
 */
function validateNot(node: ASTNotNode, path: string[], issues: ValidationIssue[]): void {
  const childPath = [...path, 'child'];
  
  if (node.child.type === 'group') {
    validateGroup(node.child, childPath, issues);
  } else if (node.child.type === 'condition') {
    validateCondition(node.child, childPath, issues);
  }
}

/**
 * Validate a condition node
 */
function validateCondition(condition: ConditionNode, path: string[], issues: ValidationIssue[]): void {
  switch (condition.condition_type) {
    case 'class':
      if (!condition.class_uuid || condition.class_uuid.trim() === '') {
        issues.push({
          severity: 'error',
          message: 'Class condition requires a class selection',
          path,
          suggestion: 'Select a class from the dropdown',
        });
      }
      break;
      
    case 'property':
      if (!condition.property_name || condition.property_name.trim() === '') {
        issues.push({
          severity: 'error',
          message: 'Property condition requires a property name',
          path,
          suggestion: 'Enter a property name',
        });
      }
      
      // Value required for most operators
      if (!['is_empty', 'is_not_empty'].includes(condition.operator)) {
        if (condition.value === undefined || condition.value === null || condition.value === '') {
          issues.push({
            severity: 'error',
            message: 'Property condition requires a value',
            path,
            suggestion: `Enter a value for the ${condition.operator} operator`,
          });
        }
      }
      break;
      
    case 'content':
      if (!condition.value || condition.value.trim() === '') {
        issues.push({
          severity: 'error',
          message: 'Content condition requires a search term',
          path,
          suggestion: 'Enter text to search for',
        });
      }
      break;
      
    case 'reference':
      if (!condition.target_uuid || condition.target_uuid.trim() === '') {
        issues.push({
          severity: 'error',
          message: 'Reference condition requires a target node',
          path,
          suggestion: 'Select a node to reference',
        });
      }
      
      // Validate nested group if present
      if (condition.nested_group) {
        validateGroup(condition.nested_group, [...path, 'nested_group'], issues);
      }
      break;
      
    case 'reference_path':
      if (condition.nested_group) {
        validateGroup(condition.nested_group, [...path, 'nested_group'], issues);
      }
      break;
      
    case 'parent_path':
      if (condition.nested_group) {
        validateGroup(condition.nested_group, [...path, 'nested_group'], issues);
      }
      
      if (condition.max_depth !== undefined && condition.max_depth < 1) {
        issues.push({
          severity: 'error',
          message: 'Max depth must be at least 1',
          path,
          suggestion: 'Set max depth to 1 or higher, or leave undefined for unlimited',
        });
      }
      break;
      
    case 'parent':
      // Validate nested group if present
      if (condition.nested_group) {
        validateGroup(condition.nested_group, [...path, 'nested_group'], issues);
      }
      break;
      
    case 'child':
      // Validate nested group if present
      if (condition.nested_group) {
        validateGroup(condition.nested_group, [...path, 'nested_group'], issues);
      }
      break;
      
    case 'child_path':
      if (condition.nested_group) {
        validateGroup(condition.nested_group, [...path, 'nested_group'], issues);
      }
      
      if (condition.max_depth !== undefined && condition.max_depth < 1) {
        issues.push({
          severity: 'error',
          message: 'Max depth must be at least 1',
          path,
          suggestion: 'Set max depth to 1 or higher, or leave undefined for unlimited',
        });
      }
      break;
      
    case 'class_path':
      if (condition.nested_group) {
        validateGroup(condition.nested_group, [...path, 'nested_group'], issues);
      }
      break;
  }
}

/**
 * Detect contradictory conditions in a group
 */
function detectContradictions(group: GroupNode, path: string[], issues: ValidationIssue[]): void {
  if (group.logic !== 'AND') return; // Only AND groups can have contradictions
  
  const conditions = group.children.filter(child => child.type === 'condition') as ConditionNode[];
  
  // Check for duplicate identical conditions
  for (let i = 0; i < conditions.length; i++) {
    for (let j = i + 1; j < conditions.length; j++) {
      if (areConditionsIdentical(conditions[i], conditions[j])) {
        issues.push({
          severity: 'info',
          message: 'Duplicate condition detected',
          path,
          suggestion: 'Remove duplicate condition',
        });
      }
    }
  }
  
  // Check for contradictory content conditions
  const contentConditions = conditions.filter(c => c.condition_type === 'content');
  if (contentConditions.length >= 2) {
    const equalConditions = contentConditions.filter(c => c.operator === 'equals');
    if (equalConditions.length >= 2) {
      const values = equalConditions.map(c => c.value);
      const uniqueValues = new Set(values);
      if (uniqueValues.size > 1) {
        issues.push({
          severity: 'warning',
          message: 'Contradictory content conditions: content cannot equal multiple different values',
          path,
          suggestion: 'Change AND to OR, or remove conflicting conditions',
        });
      }
    }
  }
}

/**
 * Check if two conditions are identical
 */
function areConditionsIdentical(a: ConditionNode, b: ConditionNode): boolean {
  if (a.condition_type !== b.condition_type) return false;
  
  // Deep comparison based on condition type
  return JSON.stringify(a) === JSON.stringify(b);
}

// ==================== Validation Utilities ====================

/**
 * Get human-readable error summary
 */
export function getValidationSummary(result: ValidationResult): string {
  if (result.valid && result.issues.length === 0) {
    return 'Query is valid';
  }
  
  const errors = result.issues.filter(i => i.severity === 'error').length;
  const warnings = result.issues.filter(i => i.severity === 'warning').length;
  const infos = result.issues.filter(i => i.severity === 'info').length;
  
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? 's' : ''}`);
  if (infos > 0) parts.push(`${infos} info`);
  
  return parts.join(', ');
}

/**
 * Check if validation allows saving
 */
export function canSaveQuery(result: ValidationResult): boolean {
  return result.valid;
}
