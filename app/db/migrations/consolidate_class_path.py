"""Migration: consolidate the deprecated class_path condition into class.

The normal ``class`` condition already resolves class inheritance through
``class_extend``, so ``class_path`` was redundant and is not supported by the
backend SQL compiler. This migration rewrites saved QueryAST JSON that still
contains ``condition_type: "class_path"`` (or legacy ``"type": "CLASS_PATH"``)
into equivalent ``class`` conditions.

- Static class_path with one class -> single ClassCondition.
- Static class_path with many classes -> OR group of ClassConditions.
- Dynamic class_path with nested_group -> ClassCondition with nested_group.
"""

from __future__ import annotations

import json
from typing import Any

import asyncpg


async def run(conn: asyncpg.Connection) -> None:
    """Run the migration."""
    await _migrate_node_view_queries(conn)
    await _migrate_node_name_queries(conn)


async def _migrate_node_view_queries(conn: asyncpg.Connection) -> None:
    rows = await conn.fetch(
        """
        SELECT id, query_json
        FROM node_view
        WHERE query_json::text LIKE '%%class_path%%'
           OR query_json::text LIKE '%%CLASS_PATH%%'
        """
    )
    for row in rows:
        query_json = row["query_json"]
        if not isinstance(query_json, dict):
            try:
                query_json = json.loads(query_json)
            except (TypeError, json.JSONDecodeError):
                continue
        new_json = _transform(query_json)
        if new_json != query_json:
            await conn.execute(
                "UPDATE node_view SET query_json = $1::jsonb WHERE id = $2",
                json.dumps(new_json),
                row["id"],
            )


async def _migrate_node_name_queries(conn: asyncpg.Connection) -> None:
    rows = await conn.fetch(
        """
        SELECT id, name
        FROM node
        WHERE name::text LIKE '%%class_path%%'
           OR name::text LIKE '%%CLASS_PATH%%'
        """
    )
    for row in rows:
        name = row["name"]
        if not isinstance(name, dict):
            try:
                name = json.loads(name)
            except (TypeError, json.JSONDecodeError):
                continue
        new_name = _transform(name)
        if new_name != name:
            await conn.execute(
                "UPDATE node SET name = $1::jsonb WHERE id = $2",
                json.dumps(new_name),
                row["id"],
            )


def _transform(value: Any) -> Any:
    """Recursively rewrite class_path conditions into class conditions."""
    if isinstance(value, list):
        return [_transform(item) for item in value]
    if not isinstance(value, dict):
        return value

    # Legacy QueryBlock tree
    if value.get("type") == "CLASS_PATH":
        return {
            **value,
            "type": "CLASS",
        }

    # New QueryAST condition
    if value.get("type") == "condition" and value.get("condition_type") == "class_path":
        return _convert_class_path_condition(value)

    return {key: _transform(child) for key, child in value.items()}


def _convert_class_path_condition(condition: dict[str, Any]) -> dict[str, Any] | None:
    """Convert a class_path condition to class condition(s)."""
    capabilities = {k: v for k, v in condition.items() if k in ("capabilities", "is_system")}

    class_uuids = condition.get("class_uuids") or []
    class_ids = condition.get("class_ids") or []
    nested_group = condition.get("nested_group")

    def _class_condition(**kwargs: Any) -> dict[str, Any]:
        return {
            "type": "condition",
            "condition_type": "class",
            "operator": "contains",
            **kwargs,
            **capabilities,
        }

    conditions: list[dict[str, Any]] = []
    for uuid in class_uuids:
        conditions.append(_class_condition(class_uuid=uuid))
    for cid in class_ids:
        conditions.append(_class_condition(class_id=cid))

    if nested_group is not None:
        conditions.append(_class_condition(nested_group=nested_group))

    if not conditions:
        # No usable data; drop the condition.
        return None

    if len(conditions) == 1:
        return conditions[0]

    return {
        "type": "group",
        "logic": "OR",
        "children": conditions,
        **capabilities,
    }
