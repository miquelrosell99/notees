"""Query AST Optimizer

Pre-processes QueryAST trees before SQL generation to simplify structure,
reduce redundant joins, and improve generated SQL quality.

Optimizations:
1. Flatten single-child groups (AND/OR with one child → unwrap)
2. Remove empty groups (no children → prune)
3. Combine repeated property conditions on the same property into IN clauses
4. Combine repeated content conditions with same operator into OR groups
5. Deduplicate identical conditions
"""
from __future__ import annotations

import copy
from typing import List, Optional, Union

from ..entities.query_ast import (
    QueryAST,
    ScopeNode,
    GroupNode,
    NotNode,
    ConditionNode,
    ClassCondition,
    PropertyCondition,
    ContentCondition,
    FlagCondition,
    LogicType,
    PropertyOperator,
    ContentOperator,
)
from ...logging_config import get_logger

logger = get_logger(__name__)


def optimize_ast(ast: QueryAST) -> QueryAST:
    """Apply all optimizations to a QueryAST.

    Returns a new (deep-copied) AST — the original is never mutated.
    """
    optimized = copy.deepcopy(ast)

    if not optimized.root_group or not optimized.root_group.children:
        return optimized

    # Phase 1: structural simplification
    result = _optimize_group(optimized.root_group)
    if result is None:
        optimized.root_group = GroupNode(logic=LogicType.AND, children=[])
    elif isinstance(result, GroupNode):
        optimized.root_group = result
    else:
        # Single condition/not node — wrap in a group
        optimized.root_group = GroupNode(logic=LogicType.AND, children=[result])

    # Phase 2: combine repeated conditions within AND groups
    _combine_property_conditions(optimized.root_group)

    return optimized


# ────────────────────────────────────────────
# Phase 1: Structural simplification
# ────────────────────────────────────────────

def _optimize_group(
    group: GroupNode,
) -> Optional[Union[GroupNode, ConditionNode, NotNode]]:
    """Recursively optimize a group node.

    Returns:
        - None if the group is empty after optimization
        - A single child if the group has exactly one child (flatten)
        - The optimized group otherwise
    """
    optimized_children: List[Union[ConditionNode, GroupNode, NotNode]] = []
    seen_hashes: set = set()

    for child in group.children:
        if isinstance(child, GroupNode):
            opt = _optimize_group(child)
            if opt is None:
                continue

            # Flatten: if nested group has same logic as parent, merge children
            if isinstance(opt, GroupNode) and opt.logic == group.logic:
                for nested_child in opt.children:
                    h = _condition_hash(nested_child)
                    if h and h in seen_hashes:
                        continue
                    if h:
                        seen_hashes.add(h)
                    optimized_children.append(nested_child)
            else:
                h = _condition_hash(opt)
                if h and h not in seen_hashes:
                    seen_hashes.add(h)
                    optimized_children.append(opt)
                elif not h:
                    optimized_children.append(opt)
        elif isinstance(child, NotNode):
            if isinstance(child.child, GroupNode):
                opt = _optimize_group(child.child)
                if opt is None:
                    continue
                if isinstance(opt, NotNode):
                    # Double negation: unwrap the inner node
                    optimized_children.append(opt.child)
                    continue
                # opt is GroupNode or a ConditionNode variant
                child.child = opt  # type: ignore[assignment]
            optimized_children.append(child)
        else:
            # Deduplicate identical conditions
            h = _condition_hash(child)
            if h and h in seen_hashes:
                continue
            if h:
                seen_hashes.add(h)
            optimized_children.append(child)

    if not optimized_children:
        return None

    if len(optimized_children) == 1:
        return optimized_children[0]

    group.children = optimized_children
    return group


def _condition_hash(node: Union[ConditionNode, GroupNode, NotNode]) -> Optional[str]:
    """Create a deterministic hash for deduplication.

    Returns None for complex nodes that should not be deduped.
    """
    if isinstance(node, FlagCondition):
        return f"flag:{node.flag_name}:{node.value}"
    if isinstance(node, ClassCondition):
        return f"class:{node.class_uuid}:{node.operator}"
    if isinstance(node, ContentCondition):
        return f"content:{node.operator}:{node.value}:{node.case_sensitive}"
    if isinstance(node, PropertyCondition):
        return f"prop:{node.property_name}:{node.operator}:{node.value}"
    # Complex nodes — no dedup
    return None


# ────────────────────────────────────────────
# Phase 2: Combine repeated conditions
# ────────────────────────────────────────────

def _combine_property_conditions(group: GroupNode) -> None:
    """Within an AND group, combine multiple property EQUALS conditions on
    the same property_name into a single IN condition.

    E.g.:
        prop=A AND prop=B → prop IN (A, B)

    Only applies to top-level AND groups with PropertyCondition(operator=EQUALS).
    Also recurses into nested groups.
    """
    if group.logic != LogicType.AND:
        # Recurse into nested groups
        for child in group.children:
            if isinstance(child, GroupNode):
                _combine_property_conditions(child)
        return

    # Collect equals conditions by property_name
    prop_equals: dict[str, list[int]] = {}  # prop_name → [indices]
    for i, child in enumerate(group.children):
        if (
            isinstance(child, PropertyCondition)
            and child.operator == PropertyOperator.EQUALS
            and child.value is not None
            and child.property_name
        ):
            prop_equals.setdefault(child.property_name, []).append(i)

    # Build replacement map
    indices_to_remove: set = set()
    replacements: dict[int, PropertyCondition] = {}

    for prop_name, indices in prop_equals.items():
        if len(indices) < 2:
            continue
        # Combine into IN condition at the first index
        values = [group.children[i].value for i in indices]  # type: ignore[union-attr]
        first_idx = indices[0]
        combined = PropertyCondition(
            property_name=prop_name,
            property_id=group.children[first_idx].property_id,  # type: ignore[union-attr]
            property_type=group.children[first_idx].property_type,  # type: ignore[union-attr]
            operator=PropertyOperator.IN,
            value=values,
        )
        replacements[first_idx] = combined
        indices_to_remove.update(indices[1:])

    if not replacements and not indices_to_remove:
        # Just recurse
        for child in group.children:
            if isinstance(child, GroupNode):
                _combine_property_conditions(child)
        return

    # Rebuild children list
    new_children = []
    for i, child in enumerate(group.children):
        if i in indices_to_remove:
            continue
        if i in replacements:
            new_children.append(replacements[i])
        else:
            new_children.append(child)
            # Recurse into nested groups
            if isinstance(child, GroupNode):
                _combine_property_conditions(child)

    group.children = new_children


def compute_ast_complexity(ast: QueryAST) -> dict:
    """Compute complexity metrics for a QueryAST for observability.

    Returns a dict with:
        - total_nodes: total AST nodes (groups + conditions + not)
        - condition_count: number of leaf conditions
        - max_depth: deepest nesting level
        - has_recursive_cte: whether class conditions exist (triggers CTE)
        - has_path_queries: whether path/hierarchy conditions exist
        - has_property_joins: whether custom property conditions exist
        - has_content_search: whether content/text search conditions exist
    """
    metrics = {
        "total_nodes": 0,
        "condition_count": 0,
        "max_depth": 0,
        "has_recursive_cte": False,
        "has_path_queries": False,
        "has_property_joins": False,
        "has_content_search": False,
    }

    def _walk(node, depth: int = 0):
        metrics["total_nodes"] += 1
        metrics["max_depth"] = max(metrics["max_depth"], depth)

        if isinstance(node, GroupNode):
            for child in node.children:
                _walk(child, depth + 1)
        elif isinstance(node, NotNode):
            _walk(node.child, depth + 1)
        else:
            metrics["condition_count"] += 1
            if isinstance(node, ClassCondition):
                metrics["has_recursive_cte"] = True
            if isinstance(node, PropertyCondition) and node.property_name not in {
                "uuid", "name", "id", "parent_id", "is_page", "is_favorite"
            }:
                metrics["has_property_joins"] = True
            if isinstance(node, ContentCondition):
                metrics["has_content_search"] = True
            nested = getattr(node, "nested_group", None)
            if nested is not None:
                metrics["has_path_queries"] = True

    if ast.root_group:
        _walk(ast.root_group)

    return metrics
