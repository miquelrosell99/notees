"""
Tests for System Queries

Validates that system queries (linked references, child pages, etc.)
are properly protected from modification.
"""

import pytest
from app.domain.entities.query_ast import (
    QueryAST, ScopeNode, GroupNode,
    ClassCondition, PropertyCondition, ContentCondition, ReferenceCondition,
    ConditionType, ScopeType, LogicType, PropertyType, PropertyOperator, ContentOperator
)
from app.domain.services.query_ast_validation import validate_query_ast, can_save_query


def test_system_query_validation_blocks_modification():
    """System queries should fail validation when allow_system_modification=False"""
    
    # Create a system query
    ast = QueryAST(
        scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
        root_group=GroupNode(
            logic=LogicType.AND,
            children=[
                ReferenceCondition(
                    target_uuid="page-123",
                )
            ]
        ),
        is_system=True,
        description="Linked References"
    )
    
    # Should fail validation with default protection
    result = validate_query_ast(ast, allow_system_modification=False)
    
    assert not result.valid, "System query should fail validation"
    assert len(result.issues) > 0, "Should have validation issues"
    
    error_issue = next(
        (issue for issue in result.issues if issue.severity == 'error'),
        None
    )
    assert error_issue is not None, "Should have an error issue"
    assert "Cannot modify system query" in error_issue.message
    assert error_issue.path == "root"


def test_system_query_validation_allows_with_flag():
    """System queries should pass validation when allow_system_modification=True"""
    
    ast = QueryAST(
        scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
        root_group=GroupNode(
            logic=LogicType.AND,
            children=[
                ClassCondition(
                    class_uuid="type-123"
                )
            ]
        ),
        is_system=True,
        description="Classed Nodes"
    )
    
    # Should pass validation with flag
    result = validate_query_ast(ast, allow_system_modification=True)
    
    assert result.valid, "Should be valid with allow_system_modification=True"


def test_user_query_validation_unaffected():
    """Regular user queries should validate normally"""
    
    ast = QueryAST(
        scope=ScopeNode(scope_type=ScopeType.CURRENT_PAGE),
        root_group=GroupNode(
            logic=LogicType.AND,
            children=[
                ContentCondition(
                    operator=ContentOperator.CONTAINS,
                    value="test"
                )
            ]
        ),
        is_system=False  # or None, or omitted
    )
    
    # Should pass validation
    result = validate_query_ast(ast, allow_system_modification=False)
    
    assert result.valid, "User query should be valid"
    assert not result.has_errors(), "Should have no errors"


def test_can_save_query_blocks_system():
    """can_save_query should prevent saving system queries"""
    
    ast = QueryAST(
        scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
        root_group=GroupNode(
            logic=LogicType.AND,
            children=[
                PropertyCondition(
                    property_name="parent_uuid",
                    property_type=PropertyType.TEXT,
                    operator=PropertyOperator.EQUALS,
                    value="parent-123"
                )
            ]
        ),
        is_system=True,
        description="Child Pages"
    )
    
    # Should not allow saving
    can_save, reason = can_save_query(ast, allow_system_modification=False)
    
    assert not can_save, "Should not allow saving system query"
    assert "Cannot modify system query" in reason
    assert reason != '', "Should provide a reason"


def test_can_save_query_allows_system_with_flag():
    """can_save_query should allow system queries with flag"""
    
    ast = QueryAST(
        scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
        root_group=GroupNode(
            logic=LogicType.AND,
            children=[
                ReferenceCondition(
                    target_uuid="page-456",
                )
            ]
        ),
        is_system=True
    )
    
    # Should allow saving with flag
    can_save, reason = can_save_query(ast, allow_system_modification=True)
    
    assert can_save, "Should allow saving with flag"
    assert reason == '', "Should have no error reason"


def test_serialization_preserves_is_system():
    """Serialization should preserve the is_system flag"""
    
    ast = QueryAST(
        scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
        root_group=GroupNode(logic=LogicType.AND, children=[]),
        is_system=True,
        description="Test System Query"
    )
    
    # Serialize and deserialize
    data = ast.to_dict()
    restored = QueryAST.from_dict(data)
    
    assert restored.is_system is True, "is_system should be preserved"
    assert restored.description == "Test System Query"


def test_serialization_without_is_system():
    """Queries without is_system should serialize correctly"""
    
    ast = QueryAST(
        scope=ScopeNode(scope_type=ScopeType.CURRENT_PAGE),
        root_group=GroupNode(logic=LogicType.OR, children=[])
    )
    
    # Serialize
    data = ast.to_dict()
    
    # Should not include is_system if not set
    assert 'is_system' not in data or data['is_system'] is None
    
    # Deserialize
    restored = QueryAST.from_dict(data)
    assert restored.is_system is None or restored.is_system is False


def test_empty_system_query_warning():
    """Empty system queries should still get empty query warning"""
    
    ast = QueryAST(
        scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
        root_group=GroupNode(logic=LogicType.AND, children=[]),  # Empty
        is_system=True
    )
    
    # Should fail due to system protection first
    result = validate_query_ast(ast, allow_system_modification=False)
    
    assert not result.valid
    assert any(
        issue.message == "Cannot modify system query" 
        for issue in result.issues
    )
    
    # With flag, should warn about empty query
    result_with_flag = validate_query_ast(ast, allow_system_modification=True)
    
    # May be valid but should have warning
    assert any(
        issue.severity == 'warning' and 'no conditions' in issue.message.lower()
        for issue in result_with_flag.issues
    )


@pytest.mark.parametrize("description,query_factory", [
    ("Linked References", lambda: QueryAST(
        scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
        root_group=GroupNode(
            logic=LogicType.AND,
            children=[
                ReferenceCondition(
                    target_uuid="page-123",
                )
            ]
        ),
        is_system=True,
        description="Linked References"
    )),
    ("Child Pages", lambda: QueryAST(
        scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
        root_group=GroupNode(
            logic=LogicType.AND,
            children=[
                PropertyCondition(
                    property_name="parent_id",
                    property_type=PropertyType.TEXT,
                    operator=PropertyOperator.EQUALS,
                    value="parent-456"
                )
            ]
        ),
        is_system=True,
        description="Child Pages"
    )),
    ("Classed Nodes", lambda: QueryAST(
        scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
        root_group=GroupNode(
            logic=LogicType.AND,
            children=[
                ClassCondition(
                    class_uuid="type-789"
                )
            ]
        ),
        is_system=True,
        description="Classed Nodes"
    )),
])
def test_common_system_queries(description, query_factory):
    """Common system query patterns should all be protected"""
    
    ast = query_factory()
    
    # All should be blocked
    result = validate_query_ast(ast, allow_system_modification=False)
    assert not result.valid, f"{description} should be protected"
    
    # All should pass with flag
    result_with_flag = validate_query_ast(ast, allow_system_modification=True)
    assert result_with_flag.valid or not result_with_flag.has_errors(), \
        f"{description} should validate with flag"
