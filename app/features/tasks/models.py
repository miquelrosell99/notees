"""Pydantic request/response models for task recurrence endpoints."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RecurrenceRuleRequest(BaseModel):
    """Body for creating or updating a recurrence rule."""

    rule_type: str = Field(
        ...,
        description="Recurrence type: daily, weekday, weekly, monthly, yearly.",
    )
    interval: int = Field(1, ge=1, description="Number of periods between occurrences.")
    weekdays: list[int] | None = Field(
        None,
        description="ISO weekdays (1=Monday .. 7=Sunday) for weekly/monthly rules.",
    )
    day_of_month: int | None = Field(
        None,
        ge=1,
        le=31,
        description="Day of the month for monthly/yearly rules.",
    )
    week_of_month: int | None = Field(
        None,
        description="Nth occurrence of a weekday in the month. -1 for last, 1-4 otherwise.",
    )
    month: int | None = Field(
        None,
        ge=1,
        le=12,
        description="Month for yearly rules.",
    )
    end_after_count: int | None = Field(
        None,
        ge=1,
        description="Stop recurrence after this many completions.",
    )
    end_date: date | None = Field(
        None,
        description="Stop recurrence after this date (inclusive).",
    )
    active: bool = True

    @field_validator("weekdays")
    @classmethod
    def _validate_weekdays(cls, value: list[int] | None) -> list[int] | None:
        if not value:
            return None
        normalized = sorted(set(value))
        for day in normalized:
            if day < 1 or day > 7:
                raise ValueError("weekdays must be ISO weekday values 1-7")
        return normalized

    @field_validator("week_of_month")
    @classmethod
    def _validate_week_of_month(cls, value: int | None) -> int | None:
        if value is None:
            return None
        if value == -1 or 1 <= value <= 4:
            return value
        raise ValueError("week_of_month must be -1 or between 1 and 4")


class RecurrenceRuleResponse(BaseModel):
    """Serialized recurrence rule."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    uuid: str
    task_node_id: int
    rule_type: str
    interval: int
    weekdays: list[int] | None
    day_of_month: int | None
    week_of_month: int | None
    month: int | None
    end_after_count: int | None
    end_date: date | None
    active: bool
    create_date: str
    write_date: str
    description: str = ""


class TaskCompletionRequest(BaseModel):
    """Body for manually recording a completion."""

    scheduled_date: date | None = None
    deadline_date: date | None = None
    status: str = "done"

    @field_validator("status")
    @classmethod
    def _validate_status(cls, value: str) -> str:
        normalized = value.lower()
        if normalized not in {"done", "cancelled", "skipped"}:
            raise ValueError("status must be one of: done, cancelled, skipped")
        return normalized


class TaskCompletionResponse(BaseModel):
    """Serialized task completion record."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    uuid: str
    task_node_id: int
    scheduled_date: date | None
    deadline_date: date | None
    status: str
    completed_at: str
    completed_by: int | None
    create_date: str
