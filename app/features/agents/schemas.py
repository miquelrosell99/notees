"""Pydantic v2 request/response models for the external agent API."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class WorkspaceListItem(BaseModel):
    """A workspace the authenticated user can access."""

    uuid: str
    name: str
    role: str


class WorkspaceDetail(BaseModel):
    """Detailed workspace information."""

    uuid: str
    name: str
    role: str


class NodeListItem(BaseModel):
    """Summary of a node returned by search/list endpoints."""

    id: str
    kind: str
    title: str
    created_at: str | None
    updated_at: str | None


class NodePropertyItem(BaseModel):
    """A property value attached to a node."""

    schema_id: str
    name: str
    value: Any


class NodeChildItem(BaseModel):
    """A child node summary."""

    id: str
    kind: str
    title: str


class NodeDetail(BaseModel):
    """Full node details returned by the agent API."""

    id: str
    kind: str
    content: Any
    properties: list[NodePropertyItem]
    classes: list[str]
    parent_id: str | None
    children: list[NodeChildItem]
    created_at: str | None
    updated_at: str | None


class ReferenceItem(BaseModel):
    """A reference edge (outgoing or incoming)."""

    id: str
    target_id: str
    title: str
    type: str


class BacklinkItem(BaseModel):
    """An incoming reference edge."""

    id: str
    source_id: str
    title: str
    type: str


class ReferencesResponse(BaseModel):
    """Outgoing references and backlinks for a node."""

    references: list[ReferenceItem]
    backlinks: list[BacklinkItem]


class ActivityItem(BaseModel):
    """A single activity-log entry."""

    id: str
    action: str
    details: dict[str, Any] | None
    timestamp: str


class NodeCreateRequest(BaseModel):
    """Request body for creating a node."""

    kind: str = Field(..., pattern="^(page|block)$")
    parent_id: str | None = None
    title: str | None = None
    class_ids: list[str] | None = None
    initial_content: Any = None


class NodeCreateResponse(BaseModel):
    """Response after creating a node."""

    id: str


class NodeUpdateRequest(BaseModel):
    """Request body for updating a node's title/content."""

    title: str | None = None
    content: Any = None


class SetPropertyRequest(BaseModel):
    """Request body for setting a property value."""

    schema_id: str
    value: Any


class AppendNoteRequest(BaseModel):
    """Request body for appending a child text block."""

    text: str


class SearchNodesParams(BaseModel):
    """Query parameters for node search."""

    q: str = ""
    kind: str | None = None
    limit: int = Field(default=20, ge=1, le=100)


class ActivityQueryParams(BaseModel):
    """Query parameters for node activity log."""

    since: datetime | None = None
