"""
Content AST entities and migration helpers.

The AST stored in node.name is a JSON array of block nodes. Each node has a
``type`` field and an optional ``schema_version`` field used for lazy migration
on read.
"""

from __future__ import annotations

from typing import Any

# Current AST schema version. Bump when the AST structure changes in a
# backward-incompatible way.
CURRENT_AST_SCHEMA_VERSION = 1

# A content AST node is represented as a dict. We keep the representation
# permissive so that existing code can continue using plain dicts; the
# schema_version field is added lazily on read.
type ContentNode = dict[str, Any]
type ContentAST = list[ContentNode]


def migrate_content_node(node: ContentNode) -> ContentNode:
    """Ensure a single AST node carries the current schema_version.

    Nodes without a schema_version are assumed to be version 1 (the version
    predating the field). The node is mutated in place and returned.

    Child nodes under the ``children`` key are migrated recursively.
    """
    if "schema_version" not in node:
        node["schema_version"] = CURRENT_AST_SCHEMA_VERSION
    children = node.get("children")
    if isinstance(children, list):
        for child in children:
            if isinstance(child, dict):
                migrate_content_node(child)
    return node


def migrate_content_ast(ast: ContentAST | None) -> ContentAST:
    """Migrate an entire AST document to the current schema version.

    The list and its nodes are mutated in place. Returns the migrated list
    (or an empty list if None was passed).
    """
    if ast is None:
        return []
    for node in ast:
        migrate_content_node(node)
    return ast
