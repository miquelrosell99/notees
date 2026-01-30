"""Test that ParentCondition and other conditions serialize properly."""
import json
from app.domain.entities.query_ast import (
    QueryAST, ScopeNode, ScopeType, GroupNode, LogicType,
    ParentCondition, PropertyCondition, PropertyOperator
)

# Create the same query structure as in DEFAULT_VIEW_CONFIGS
query_ast = QueryAST(
    scope=ScopeNode(scope_type=ScopeType.PAGES),
    root_group=GroupNode(
        logic=LogicType.AND,
        children=[
            ParentCondition(
                nested_group=GroupNode(
                    logic=LogicType.AND,
                    children=[
                        PropertyCondition(
                            property_name="uuid",
                            property_type="text",
                            operator=PropertyOperator.EQUALS,
                            value="{current_node_uuid}"
                        )
                    ]
                )
            )
        ]
    ),
    is_system=True
)

# Try to serialize it
try:
    query_dict = query_ast.to_dict()
    json_str = json.dumps(query_dict, indent=2)
    print("✅ Serialization successful!")
    print("\nSerialized JSON:")
    print(json_str)
except Exception as e:
    print(f"❌ Serialization failed: {e}")
    import traceback
    traceback.print_exc()
