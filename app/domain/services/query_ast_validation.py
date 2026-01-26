"""Query AST Validation

Validates QueryAST structures for correctness and provides helpful error messages.
"""
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

from app.domain.entities.query_ast import (
    QueryAST,
    ScopeNode,
    GroupNode,
    ConditionNode,
    NotNode,
    TypeCondition,
    PropertyCondition,
    ContentCondition,
    ReferenceCondition,
)


@dataclass
class ValidationIssue:
    """Represents a validation issue."""
    severity: str  # 'error', 'warning', 'info'
    message: str
    path: str
    suggestion: Optional[str] = None


@dataclass
class ValidationResult:
    """Result of AST validation."""
    valid: bool
    issues: List[ValidationIssue]
    
    def has_errors(self) -> bool:
        """Check if there are any error-level issues."""
        return any(issue.severity == 'error' for issue in self.issues)
    
    def has_warnings(self) -> bool:
        """Check if there are any warning-level issues."""
        return any(issue.severity == 'warning' for issue in self.issues)


def validate_query_ast(ast: QueryAST) -> ValidationResult:
    """
    Validate a complete QueryAST structure.
    
    Returns:
        ValidationResult with any issues found
    """
    issues: List[ValidationIssue] = []
    
    # Validate scope
    scope_issues = validate_scope(ast.scope, "scope")
    issues.extend(scope_issues)
    
    # Validate root group
    group_issues = validate_group(ast.root_group, "root_group")
    issues.extend(group_issues)
    
    # Check for empty query
    if not ast.root_group.children:
        issues.append(ValidationIssue(
            severity='warning',
            message='Query has no conditions',
            path='root_group',
            suggestion='Add at least one condition to filter results'
        ))
    
    return ValidationResult(
        valid=not any(issue.severity == 'error' for issue in issues),
        issues=issues
    )


def validate_scope(scope: ScopeNode, path: str) -> List[ValidationIssue]:
    """Validate a scope node."""
    issues: List[ValidationIssue] = []
    
    # Validate specific_pages scope has page_uuids
    if scope.scope_type == 'specific_pages':
        if not scope.page_uuids or len(scope.page_uuids) == 0:
            issues.append(ValidationIssue(
                severity='error',
                message='Specific pages scope requires at least one page',
                path=f'{path}.page_uuids',
                suggestion='Add pages to search within or change scope type'
            ))
    
    return issues


def validate_group(group: GroupNode, path: str, depth: int = 0) -> List[ValidationIssue]:
    """Validate a group node recursively."""
    issues: List[ValidationIssue] = []
    
    # Check nesting depth
    if depth > 5:
        issues.append(ValidationIssue(
            severity='warning',
            message=f'Deep nesting detected (depth {depth})',
            path=path,
            suggestion='Consider flattening the query structure for better performance'
        ))
    
    # Validate each child
    for i, child in enumerate(group.children):
        child_path = f'{path}.children[{i}]'
        
        if isinstance(child, GroupNode):
            # Recursive validation for nested groups
            child_issues = validate_group(child, child_path, depth + 1)
            issues.extend(child_issues)
            
            # Warn about empty nested groups
            if not child.children:
                issues.append(ValidationIssue(
                    severity='warning',
                    message='Empty nested group',
                    path=child_path,
                    suggestion='Add conditions or remove this group'
                ))
        
        elif isinstance(child, NotNode):
            # Validate NOT node
            if isinstance(child.child, GroupNode):
                child_issues = validate_group(child.child, f'{child_path}.child', depth + 1)
                issues.extend(child_issues)
            else:
                cond_issues = validate_condition(child.child, f'{child_path}.child')
                issues.extend(cond_issues)
        
        else:
            # Validate condition
            cond_issues = validate_condition(child, child_path)
            issues.extend(cond_issues)
    
    return issues


def validate_condition(condition: ConditionNode, path: str) -> List[ValidationIssue]:
    """Validate a condition node."""
    issues: List[ValidationIssue] = []
    
    if isinstance(condition, TypeCondition):
        if not condition.type_uuid:
            issues.append(ValidationIssue(
                severity='error',
                message='Type condition missing type UUID',
                path=f'{path}.type_uuid',
                suggestion='Select a type/class for this condition'
            ))
    
    elif isinstance(condition, PropertyCondition):
        if not condition.property_name:
            issues.append(ValidationIssue(
                severity='error',
                message='Property condition missing property name',
                path=f'{path}.property_name',
                suggestion='Enter a property name'
            ))
        
        # Check for value when operator requires it
        if condition.operator not in ('is_empty', 'is_not_empty'):
            if condition.value is None or condition.value == '':
                issues.append(ValidationIssue(
                    severity='warning',
                    message=f'Property condition with operator "{condition.operator}" has no value',
                    path=f'{path}.value',
                    suggestion='Provide a value to compare against'
                ))
    
    elif isinstance(condition, ContentCondition):
        if not condition.value:
            issues.append(ValidationIssue(
                severity='warning',
                message='Content condition has no search text',
                path=f'{path}.value',
                suggestion='Enter text to search for'
            ))
    
    elif isinstance(condition, ReferenceCondition):
        if not condition.target_uuid:
            issues.append(ValidationIssue(
                severity='error',
                message='Reference condition missing target UUID',
                path=f'{path}.target_uuid',
                suggestion='Select a node to check references against'
            ))
    
    return issues


def can_save_query(ast: QueryAST) -> tuple[bool, str]:
    """
    Check if a query can be saved (no blocking errors).
    
    Returns:
        (can_save, reason) tuple
    """
    validation = validate_query_ast(ast)
    
    if validation.has_errors():
        error_messages = [
            issue.message for issue in validation.issues
            if issue.severity == 'error'
        ]
        return False, '; '.join(error_messages)
    
    return True, ''
