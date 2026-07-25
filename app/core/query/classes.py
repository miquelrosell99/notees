"""Read-only query helpers for the derived ``class`` table."""

from __future__ import annotations

import json
from dataclasses import dataclass

from app.core.workspace_store import WorkspaceStore


@dataclass(frozen=True)
class ClassRow:
    id: str
    workspace_id: str
    name: str
    icon: str | None
    color: str | None
    description: str | None
    extends_class_ids: list[str]
    active: bool
    created_at: str
    updated_at: str


_SELECT_COLUMNS = """
    id,
    workspace_id,
    name,
    icon,
    color,
    description,
    extends_class_ids,
    active,
    created_at,
    updated_at
"""


def _parse_extends(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _row_to_class_row(row) -> ClassRow:  # type: ignore[no-untyped-def]
    return ClassRow(
        id=row["id"],
        workspace_id=row["workspace_id"],
        name=row["name"],
        icon=row["icon"],
        color=row["color"],
        description=row["description"],
        extends_class_ids=_parse_extends(row["extends_class_ids"]),
        active=bool(row["active"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def list_classes(workspace_store: WorkspaceStore, workspace_id: str) -> list[ClassRow]:
    """Return active class definitions for ``workspace_id`` ordered by name."""
    rows = await workspace_store.query(
        f"""
        SELECT {_SELECT_COLUMNS}
        FROM class
        WHERE workspace_id = ? AND active = 1
        ORDER BY name
        """,
        (workspace_id,),
    )
    return [_row_to_class_row(row) for row in rows]


async def get_class(workspace_store: WorkspaceStore, class_id: str) -> ClassRow | None:
    """Return a single class definition by id, or ``None`` if not found."""
    rows = await workspace_store.query(
        f"""
        SELECT {_SELECT_COLUMNS}
        FROM class
        WHERE id = ?
        LIMIT 1
        """,
        (class_id,),
    )
    return _row_to_class_row(rows[0]) if rows else None
