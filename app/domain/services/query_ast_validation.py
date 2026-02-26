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
    ClassCondition,
    PropertyCondition,
    ContentCondition,
    ReferenceCondition,
    ParentCondition,
    ChildCondition,
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


def validate_query_ast(ast: QueryAST, allow_system_modification: bool = False) -> ValidationResult:
    """
    Validate a complete QueryAST structure.
    
    Args:
        ast: The QueryAST to validate
        allow_system_modification: If False, blocks modification of system queries
    
    Returns:
        ValidationResult with any issues found
    """
    issues: List[ValidationIssue] = []
    
    # Check if trying to modify a system query
    if ast.is_system and not allow_system_modification:
        issues.append(ValidationIssue(
            severity='error',
            message='Cannot modify system query',
            path='root',
            suggestion='System queries (linked references, child pages, etc.) are read-only'
        ))
        return ValidationResult(valid=False, issues=issues)
    
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
    
    if isinstance(condition, ClassCondition):
        if not condition.class_uuid:
            issues.append(ValidationIssue(
                severity='error',
                message='Class condition missing class UUID',
                path=f'{path}.class_uuid',
                suggestion='Select a class for this condition'
            ))
    
    elif isinstance(condition, PropertyCondition):
        # Built-in columns are identified by name only (they have no UUID)
        BUILTIN_COLUMNS = {'uuid', 'name', 'id', 'parent_id', 'is_page', 'is_favorite'}
        is_builtin = condition.property_name in BUILTIN_COLUMNS
        if not is_builtin and not condition.property_uuid:
            issues.append(ValidationIssue(
                severity='error',
                message='Property condition missing property UUID',
                path=f'{path}.property_uuid',
                suggestion='Select a property'
            ))
        elif not condition.property_name:
            issues.append(ValidationIssue(
                severity='error',
                message='Property condition missing property name',
                path=f'{path}.property_name',
                suggestion='Select a property'
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
        operator = getattr(condition, 'operator', 'references')
        # Only validate target_uuid if operator requires a value
        if operator not in ('has_references', 'has_no_references'):
            if not condition.target_uuid and not getattr(condition, 'target_uuids', None):
                issues.append(ValidationIssue(
                    severity='error',
                    message='Reference condition missing target UUID',
                    path=f'{path}.target_uuid',
                    suggestion='Select a node to check references against'
                ))
    
    elif isinstance(condition, ParentCondition):
        operator = getattr(condition, 'operator', 'has_parent')
        # Only validate if operator requires a value
        if operator not in ('has_no_parent', 'has_any_parent'):
            has_static = condition.parent_uuid or getattr(condition, 'parent_uuids', None)
            has_dynamic = condition.nested_group
            if not has_static and not has_dynamic:
                issues.append(ValidationIssue(
                    severity='error',
                    message='Parent condition requires parent_uuid(s) or nested_group',
                    path=f'{path}',
                    suggestion='Select a parent node or add filtering criteria'
                ))
    
    elif isinstance(condition, ChildCondition):
        operator = getattr(condition, 'operator', 'has_child')
        # Only validate if operator requires a value
        if operator not in ('has_no_child', 'has_any_child'):
            has_static = getattr(condition, 'child_uuids', None)
            has_dynamic = condition.nested_group
            if not has_static and not has_dynamic:
                issues.append(ValidationIssue(
                    severity='error',
                    message='Child condition requires child_uuids or nested_group',
                    path=f'{path}',
                    suggestion='Select child nodes or add filtering criteria'
                ))
    
    return issues


def can_save_query(ast: QueryAST, allow_system_modification: bool = False) -> tuple[bool, str]:
    """
    Check if a query can be saved (no blocking errors).
    
    Args:
        ast: The QueryAST to check
        allow_system_modification: If False, blocks modification of system queries
    
    Returns:
        (can_save, reason) tuple
    """
    validation = validate_query_ast(ast, allow_system_modification)
    
    if validation.has_errors():
        error_messages = [
            issue.message for issue in validation.issues
            if issue.severity == 'error'
        ]
        return False, '; '.join(error_messages)
    
    return True, ''
