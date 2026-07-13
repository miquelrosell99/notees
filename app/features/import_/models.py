"""Pydantic models for the import feature."""

from __future__ import annotations

from pydantic import BaseModel, Field


class MarkdownImportItem(BaseModel):
    """A single Markdown document to import."""

    content: str = Field(..., description="Full Markdown text including optional YAML frontmatter.")
    parent_uuid: str | None = Field(None, description="Optional parent page UUID.")
    sequence: float = Field(0.0, description="Order among siblings when importing multiple items.")


class MarkdownImportRequest(BaseModel):
    """Batch request to import Markdown documents."""

    items: list[MarkdownImportItem]
    uuid_conflict_mode: str = Field(
        "block",
        description="How to handle UUID collisions: 'block' rejects duplicates, 'return_existing' returns the existing node.",
    )


class MarkdownImportResult(BaseModel):
    """Result of importing one Markdown document."""

    node_uuid: str
    title: str
    created: bool
    existing: bool = False


class MarkdownImportResponse(BaseModel):
    """Response for a Markdown import request."""

    results: list[MarkdownImportResult]
