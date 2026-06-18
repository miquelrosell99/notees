"""Task recurrence and completion history endpoints.

These endpoints provide a dedicated source of truth for recurring task rules
and their completion history, separate from the legacy ``task_recurrence``
selection property that is kept for QueryAST compatibility.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_current_user, get_node_service
from app.domain.entities import TaskCompletion, TaskRecurrence
from app.features.nodes.node_service import NodeService
from app.features.tasks.dependencies import (
    get_task_completion_repository,
    get_task_recurrence_repository,
)
from app.features.tasks.models import (
    RecurrenceRuleRequest,
    RecurrenceRuleResponse,
    TaskCompletionRequest,
    TaskCompletionResponse,
)
from app.features.tasks.port import TaskCompletionRepository, TaskRecurrenceRepository
from app.features.tasks.service import describe_rule
from app.models import User

router = APIRouter(prefix="/tasks", tags=["tasks"])


async def _require_task(
    node_id: int, node_service: NodeService
) -> None:
    """Validate that ``node_id`` refers to an existing, non-deleted task."""
    node = await node_service.get_node(node_id)
    if not node or node.is_deleted:
        raise HTTPException(status_code=404, detail=f"Task {node_id} not found")
    if not node.is_task:
        raise HTTPException(
            status_code=400,
            detail=f"Node {node_id} is not a task",
        )


def _entity_to_recurrence_response(rule: TaskRecurrence) -> RecurrenceRuleResponse:
    """Map a ``TaskRecurrence`` entity to its API response."""
    return RecurrenceRuleResponse(
        id=rule.id,  # type: ignore[arg-type]
        uuid=rule.uuid,
        task_node_id=rule.task_node_id,
        rule_type=rule.rule_type,
        interval=rule.interval,
        weekdays=rule.weekdays,
        day_of_month=rule.day_of_month,
        week_of_month=rule.week_of_month,
        month=rule.month,
        end_after_count=rule.end_after_count,
        end_date=rule.end_date,
        active=rule.active,
        create_date=rule.create_date,
        write_date=rule.write_date,
        description=describe_rule(rule),
    )


def _entity_to_completion_response(
    completion: TaskCompletion,
) -> TaskCompletionResponse:
    """Map a ``TaskCompletion`` entity to its API response."""
    completed_at = completion.completed_at
    if not isinstance(completed_at, str):
        completed_at = completed_at.isoformat()
    return TaskCompletionResponse(
        id=completion.id,  # type: ignore[arg-type]
        uuid=completion.uuid,
        task_node_id=completion.task_node_id,
        scheduled_date=completion.scheduled_date,
        deadline_date=completion.deadline_date,
        status=completion.status,
        completed_at=completed_at,
        completed_by=completion.completed_by,
        create_date=completion.create_date,
    )


@router.get("/{node_id}/recurrence", response_model=RecurrenceRuleResponse | None)
async def get_recurrence_rule(
    node_id: int,
    user: User = Depends(get_current_user),
    node_service: NodeService = Depends(get_node_service),
    recurrence_repo: TaskRecurrenceRepository = Depends(get_task_recurrence_repository),
) -> RecurrenceRuleResponse | None:
    """Return the active recurrence rule for a task, or null if none exists."""
    await _require_task(node_id, node_service)
    rule = await recurrence_repo.get_by_task(node_id)
    if rule is None:
        return None
    return _entity_to_recurrence_response(rule)


@router.put("/{node_id}/recurrence", response_model=RecurrenceRuleResponse)
async def set_recurrence_rule(
    node_id: int,
    request: RecurrenceRuleRequest,
    user: User = Depends(get_current_user),
    node_service: NodeService = Depends(get_node_service),
    recurrence_repo: TaskRecurrenceRepository = Depends(get_task_recurrence_repository),
) -> RecurrenceRuleResponse:
    """Create or replace the recurrence rule for a task."""
    await _require_task(node_id, node_service)
    rule = TaskRecurrence(
        task_node_id=node_id,
        workspace_id=node_service.workspace_id,
        rule_type=request.rule_type,
        interval=request.interval,
        weekdays=request.weekdays,
        day_of_month=request.day_of_month,
        week_of_month=request.week_of_month,
        month=request.month,
        end_after_count=request.end_after_count,
        end_date=request.end_date,
        active=request.active,
    )
    rule.touch(int(user.id))
    saved = await recurrence_repo.upsert(rule)
    return _entity_to_recurrence_response(saved)


@router.delete("/{node_id}/recurrence")
async def delete_recurrence_rule(
    node_id: int,
    user: User = Depends(get_current_user),
    node_service: NodeService = Depends(get_node_service),
    recurrence_repo: TaskRecurrenceRepository = Depends(get_task_recurrence_repository),
) -> dict[str, bool]:
    """Remove the recurrence rule from a task."""
    await _require_task(node_id, node_service)
    deleted = await recurrence_repo.delete(node_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"No recurrence rule for task {node_id}")
    return {"deleted": True}


@router.get("/{node_id}/completions", response_model=list[TaskCompletionResponse])
async def list_task_completions(
    node_id: int,
    user: User = Depends(get_current_user),
    node_service: NodeService = Depends(get_node_service),
    completion_repo: TaskCompletionRepository = Depends(get_task_completion_repository),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> list[TaskCompletionResponse]:
    """List completion history for a task, newest first."""
    await _require_task(node_id, node_service)
    completions = await completion_repo.list_by_task(node_id, limit=limit, offset=offset)
    return [_entity_to_completion_response(c) for c in completions]


@router.post("/{node_id}/completions", response_model=TaskCompletionResponse)
async def record_task_completion(
    node_id: int,
    request: TaskCompletionRequest,
    user: User = Depends(get_current_user),
    node_service: NodeService = Depends(get_node_service),
    completion_repo: TaskCompletionRepository = Depends(get_task_completion_repository),
) -> TaskCompletionResponse:
    """Manually record a completion (or skip) for a task occurrence."""
    await _require_task(node_id, node_service)
    completion = TaskCompletion(
        task_node_id=node_id,
        workspace_id=node_service.workspace_id,
        scheduled_date=request.scheduled_date,
        deadline_date=request.deadline_date,
        status=request.status,
        completed_by=int(user.id),
    )
    saved = await completion_repo.create(completion)
    return _entity_to_completion_response(saved)


@router.delete("/{node_id}/completions/{completion_id}")
async def delete_task_completion(
    node_id: int,
    completion_id: int,
    user: User = Depends(get_current_user),
    node_service: NodeService = Depends(get_node_service),
    completion_repo: TaskCompletionRepository = Depends(get_task_completion_repository),
) -> dict[str, bool]:
    """Delete a single completion record."""
    await _require_task(node_id, node_service)
    deleted = await completion_repo.delete(completion_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Completion {completion_id} not found")
    return {"deleted": True}
