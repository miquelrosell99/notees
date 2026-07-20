"""Plugin-facing ports and adapter interfaces.

Plugins implement these interfaces to extend Notees. Core domain services are
exposed to plugins through the PluginContext; plugins should never import
PostgreSQL implementations directly.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar

from fastapi import APIRouter

if TYPE_CHECKING:
    from .context import PluginContext


@dataclass
class ImportResult:
    """Result returned by an importer adapter."""

    created_node_ids: list[str] = field(default_factory=list)
    updated_node_ids: list[str] = field(default_factory=list)
    skipped_count: int = 0
    error_count: int = 0
    messages: list[str] = field(default_factory=list)


@dataclass
class ImportContext:
    """Context passed to an importer adapter during execution."""

    workspace_id: int
    user_id: int
    plugin_context: PluginContext
    filename: str | None = None
    options: dict[str, Any] = field(default_factory=dict)
    workspace_uuid: str | None = None
    actor_uuid: str | None = None


class ImporterAdapter(ABC):
    """Backend adapter for importing external data into Notees nodes."""

    id: ClassVar[str] = ""
    label: ClassVar[str] = ""
    file_extensions: ClassVar[list[str]] = []

    @abstractmethod
    async def import_data(
        self,
        payload: bytes,
        content_type: str | None,
        context: ImportContext,
    ) -> ImportResult:
        """Import the provided data and return a result summary."""


@dataclass
class ExportResult:
    """Result returned by an exporter adapter."""

    content: bytes
    filename: str
    mime_type: str


@dataclass
class ExportContext:
    """Context passed to an exporter adapter during execution."""

    node_ids: list[int]
    workspace_id: int
    user_id: int
    plugin_context: PluginContext
    options: dict[str, Any] = field(default_factory=dict)
    workspace_uuid: str | None = None
    actor_uuid: str | None = None


class ExporterAdapter(ABC):
    """Backend adapter for exporting Notees nodes to a custom format."""

    format_id: ClassVar[str] = ""
    label: ClassVar[str] = ""
    extension: ClassVar[str] = ""
    mime_type: ClassVar[str] = "application/octet-stream"

    @abstractmethod
    async def export_nodes(
        self,
        context: ExportContext,
    ) -> ExportResult:
        """Export the requested nodes and return file content."""


@dataclass
class SyncResult:
    """Result returned by a sync source."""

    created_node_ids: list[str] = field(default_factory=list)
    updated_node_ids: list[str] = field(default_factory=list)
    deleted_node_ids: list[str] = field(default_factory=list)
    messages: list[str] = field(default_factory=list)


@dataclass
class SyncContext:
    """Context passed to a sync source during execution."""

    workspace_id: int
    user_id: int
    plugin_context: PluginContext
    full_resync: bool = False
    workspace_uuid: str | None = None
    actor_uuid: str | None = None


class SyncSource(ABC):
    """Backend adapter for a pull-only sync source."""

    id: ClassVar[str] = ""
    label: ClassVar[str] = ""

    @abstractmethod
    async def sync(self, context: SyncContext) -> SyncResult:
        """Pull changes from an external source and apply them to Notees nodes."""


@dataclass
class SettingSchema:
    """Schema for a plugin-contributed workspace-scoped setting."""

    id: str
    type: str  # string, number, boolean, select, multiselect
    label: str
    default: Any = None
    options: list[dict[str, Any]] = field(default_factory=list)
    description: str | None = None
    required: bool = False


@dataclass
class RouterRegistration:
    """Registered plugin router."""

    plugin_id: str
    router: APIRouter
    prefix: str


@dataclass
class ClassSideEffectContext:
    """Context passed to a class side-effect handler.

    Identifiers use the operation-log core's public UUIDs so handlers can
    locate nodes in the derived SQLite state or in PostgreSQL metadata.
    """

    node_uuid: str
    class_uuid: str
    workspace_uuid: str
    actor_uuid: str
    plugin_context: PluginContext
    added: bool = False
    removed: bool = False


ClassSideEffectHandler = Callable[[ClassSideEffectContext], Awaitable[Any] | Any]
