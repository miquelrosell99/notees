"""Pydantic request/response models for the export feature."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, field_validator


class ExportFormat(StrEnum):
    """Export formats."""

    MARKDOWN = "markdown"
    HTML = "html"
    PDF = "pdf"
    TEXT = "text"
    JSON = "json"


class ExportRequest(BaseModel):
    """Export request."""

    node_uuids: list[str]
    format: str
    include_children: bool = True
    include_backlinks: bool = False
    layout: str = "outline"
    formatting: bool = True
    style: str | None = None
    properties: str = "none"
    density: str = "comfortable"
    numbering: str = "none"
    measure: str = "full"
    doctype: str = "none"
    section_break: bool = False
    show_uuid: bool = False
    link_style: str = "raw"
    theme_mode: str = "light"
    cover_page: bool = False
    page_size: str = "a4"
    include_child_pages: bool = False

    @field_validator("layout")
    @classmethod
    def validate_layout(cls, v):
        if v not in {"outline", "flat"}:
            raise ValueError("layout must be one of: outline, flat")
        return v

    @field_validator("properties")
    @classmethod
    def validate_properties(cls, v):
        if v not in {"none", "main", "all"}:
            raise ValueError("properties must be one of: none, main, all")
        return v

    @field_validator("density")
    @classmethod
    def validate_density(cls, v):
        if v not in {"comfortable", "compact"}:
            raise ValueError("density must be one of: comfortable, compact")
        return v

    @field_validator("numbering")
    @classmethod
    def validate_numbering(cls, v):
        if v not in {"none", "hierarchical", "legal", "appendix"}:
            raise ValueError("numbering must be one of: none, hierarchical, legal, appendix")
        return v

    @field_validator("measure")
    @classmethod
    def validate_measure(cls, v):
        if v not in {"full", "readable", "book", "two-column"}:
            raise ValueError("measure must be one of: full, readable, book, two-column")
        return v

    @field_validator("doctype")
    @classmethod
    def validate_doctype(cls, v):
        if v not in {"none", "article", "report", "book", "legal", "academic"}:
            raise ValueError("doctype must be one of: none, article, report, book, legal, academic")
        return v

    @field_validator("link_style")
    @classmethod
    def validate_link_style(cls, v):
        if v not in {"raw", "text"}:
            raise ValueError("link_style must be one of: raw, text")
        return v

    @field_validator("theme_mode")
    @classmethod
    def validate_theme_mode(cls, v):
        if v not in {"light", "dark"}:
            raise ValueError("theme_mode must be one of: light, dark")
        return v

    @field_validator("page_size")
    @classmethod
    def validate_page_size(cls, v):
        if v not in {"a4", "letter", "legal"}:
            raise ValueError("page_size must be one of: a4, letter, legal")
        return v


class ExportResponse(BaseModel):
    """Export response."""

    content: str
    filename: str
    mime_type: str


class RenderPdfRequest(BaseModel):
    """Request body for the render-pdf endpoint."""

    html: str


class CreateExportJobResponse(BaseModel):
    """Response returned when an export job is created."""

    job_uuid: str


class ExportJobResponse(BaseModel):
    """Response returned when querying an export job status."""

    job_uuid: str
    status: str
    progress: int
    status_text: str
    download_url: str | None = None
    error: str | None = None
