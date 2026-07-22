"""Task recurrence and completion history endpoints.

These endpoints now operate on the local-first operation-log core via
:class:`app.core.workspace_store.WorkspaceStore`.  Status changes themselves are
property values and are written elsewhere as ``property.set`` operations; this
router only exposes recurrence rules and the completion history derived from
those operations.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.dependencies import get_current_user, require_read_or_write_scope, require_write_scope
from app.domain.entities import TaskRecurrence
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.features.tasks.dependencies import get_workspace_store
from app.features.tasks.models import (
    RecurrenceRuleRequest,
    RecurrenceRuleResponse,
    TaskCompletionRequest,
    TaskCompletionResponse,
)
from app.features.tasks.service import describe_rule
from app.models import User
from app.utils import utc_now_iso

router = APIRouter(
    prefix="/tasks",
    tags=["tasks"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)


async def _require_task_node(store: WorkspaceStore, node_uuid: str) -> None:
    """Validate that ``node_uuid`` refers to an existing, non-deleted task node."""
    rows = await store.query("SELECT class_ids FROM node WHERE id = ?", (node_uuid,))
    if not rows:
        raise HTTPException(status_code=404, detail=f"Task {node_uuid} not found")
    class_ids = json.loads(rows[0]["class_ids"] or "[]")
    if SYSTEM_CLASS_UUIDS["task"] not in class_ids:
        raise HTTPException(
            status_code=400,
            detail=f"Node {node_uuid} is not a task",
        )


def _rule_from_json(rule: str) -> dict:
    """Parse the stored recurrence rule JSON."""
    return json.loads(rule)


def _build_recurrence_response(row: dict) -> RecurrenceRuleResponse:
    """Map a ``task_recurrence`` derived row to its API response."""
    rule = _rule_from_json(row["rule"])
    recurrence = TaskRecurrence(**rule)
    return RecurrenceRuleResponse(
        recurrence_uuid=row["id"],
        task_node_uuid=row["node_id"],
        rule_type=rule.get("rule_type", "daily"),
        interval=rule.get("interval", 1),
        weekdays=rule.get("weekdays"),
        day_of_month=rule.get("day_of_month"),
        week_of_month=rule.get("week_of_month"),
        month=rule.get("month"),
        end_after_count=rule.get("end_after_count"),
        end_date=rule.get("end_date"),
        active=rule.get("active", True),
        create_date=row["created_at"] or "",
        write_date=row["updated_at"] or "",
        description=describe_rule(recurrence),
    )


def _build_completion_response(row: dict) -> TaskCompletionResponse:
    """Map a ``task_completion`` derived row to its API response."""
    return TaskCompletionResponse(
        completion_uuid=row["id"],
        task_node_uuid=row["node_id"],
        scheduled_date=row["scheduled_date"],
        deadline_date=row["deadline_date"],
        status=row["status"],
        completed_at=row["completed_at"],
        completed_by=row["actor_id"],
        create_date=row["completed_at"],
    )


@router.get("/{node_uuid}/recurrence", response_model=RecurrenceRuleResponse | None)
async def get_recurrence_rule(
    node_uuid: str,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> RecurrenceRuleResponse | None:
    """Return the active recurrence rule for a task, or null if none exists."""
    await store.sync()
    await _require_task_node(store, node_uuid)

    rows = await store.query(
        "SELECT id, node_id, rule, created_at, updated_at FROM task_recurrence WHERE node_id = ?",
        (node_uuid,),
    )
    if not rows:
        return None
    return _build_recurrence_response(dict(rows[0]))


@router.put("/{node_uuid}/recurrence", response_model=RecurrenceRuleResponse, dependencies=[Depends(require_write_scope)])
async def set_recurrence_rule(
    node_uuid: str,
    request: RecurrenceRuleRequest,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> RecurrenceRuleResponse:
    """Create or replace the recurrence rule for a task."""
    await store.sync()
    await _require_task_node(store, node_uuid)

    recurrence_id = uuidv7()
    rule = request.model_dump(mode="json")
    await store.set_task_recurrence(recurrence_id, node_uuid, rule)
    await store.sync()

    rows = await store.query(
        "SELECT id, node_id, rule, created_at, updated_at FROM task_recurrence WHERE node_id = ?",
        (node_uuid,),
    )
    if not rows:
        raise HTTPException(status_code=500, detail="Failed to apply recurrence rule")
    return _build_recurrence_response(dict(rows[0]))


@router.delete("/{node_uuid}/recurrence", dependencies=[Depends(require_write_scope)])
async def delete_recurrence_rule(
    node_uuid: str,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, bool]:
    """Remove the recurrence rule from a task."""
    await store.sync()
    await _require_task_node(store, node_uuid)

    rows = await store.query(
        "SELECT id FROM task_recurrence WHERE node_id = ?",
        (node_uuid,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"No recurrence rule for task {node_uuid}")

    recurrence_id = rows[0]["id"]
    await store.delete_task_recurrence(recurrence_id, node_uuid)
    await store.sync()
    return {"deleted": True}


@router.get("/{node_uuid}/completions", response_model=list[TaskCompletionResponse])
async def list_task_completions(
    node_uuid: str,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> list[TaskCompletionResponse]:
    """List completion history for a task, newest first."""
    await store.sync()
    await _require_task_node(store, node_uuid)

    rows = await store.query(
        """
        SELECT id, node_id, scheduled_date, deadline_date, status, completed_at, actor_id
        FROM task_completion
        WHERE node_id = ?
        ORDER BY completed_at DESC
        LIMIT ? OFFSET ?
        """,
        (node_uuid, limit, offset),
    )
    return [_build_completion_response(dict(row)) for row in rows]


@router.post("/{node_uuid}/completions", response_model=TaskCompletionResponse, dependencies=[Depends(require_write_scope)])
async def record_task_completion(
    node_uuid: str,
    request: TaskCompletionRequest,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> TaskCompletionResponse:
    """Manually record a completion (or skip) for a task occurrence."""
    await store.sync()
    await _require_task_node(store, node_uuid)

    completion_id = uuidv7()
    await store.record_task_completion(
        completion_id=completion_id,
        node_id=node_uuid,
        completed_at=utc_now_iso(),
        completed_by=user.uuid,
        scheduled_date=request.scheduled_date.isoformat() if request.scheduled_date else None,
        deadline_date=request.deadline_date.isoformat() if request.deadline_date else None,
        status=request.status,
    )
    await store.sync()

    rows = await store.query(
        """
        SELECT id, node_id, scheduled_date, deadline_date, status, completed_at, actor_id
        FROM task_completion
        WHERE id = ?
        """,
        (completion_id,),
    )
    if not rows:
        raise HTTPException(status_code=500, detail="Failed to apply completion record")
    return _build_completion_response(dict(rows[0]))


@router.delete("/{node_uuid}/completions/{completion_uuid}", dependencies=[Depends(require_write_scope)])
async def delete_task_completion(
    node_uuid: str,
    completion_uuid: str,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, bool]:
    """Delete a single completion record."""
    await store.sync()
    await _require_task_node(store, node_uuid)

    existing = await store.query(
        "SELECT 1 FROM task_completion WHERE id = ? AND node_id = ?",
        (completion_uuid, node_uuid),
    )
    if not existing:
        raise HTTPException(status_code=404, detail=f"Completion {completion_uuid} not found")

    await store.delete_task_completion(completion_uuid, node_uuid)
    await store.sync()
    return {"deleted": True}
