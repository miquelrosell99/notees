"""Export provider plugin API (Decision 31/34, Task 15).

Platform-level contract for export profile providers. A provider turns a
resolved node selection plus its opaque ``provider_config`` into a *manifest*:
the set of files the export tree should contain. Providers are pure with
respect to the filesystem — they never read or write files themselves; the
export engine (path validation → reconciler → materializer) owns all I/O.

The injected :class:`ExportServices` gives providers controlled access to
asset metadata/streaming, the query engine, and the class resolver without
exposing canonical storage paths or the database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, BinaryIO, Protocol, runtime_checkable


@dataclass
class ExportAttachment:
    """A resolved attachment of an exported source node."""

    asset_uuid: str
    asset_hash: str
    mime_type: str
    size: int
    original_name: str
    role: str | None = None  # resolved role option name (e.g. "representation")


@dataclass
class ExportNodeContext:
    """A resolved source node handed to providers.

    ``properties`` maps property *schema names* (e.g. ``"citekey"``,
    ``"series"``) to their plain values so filename templates can reference
    system fields and same-named user properties uniformly (Decision 29).
    """

    uuid: str
    title: str
    class_names: list[str] = field(default_factory=list)  # most specific first
    properties: dict[str, Any] = field(default_factory=dict)
    attachments: list[ExportAttachment] = field(default_factory=list)


@dataclass
class ExportFile:
    """One file the export tree should contain."""

    asset_uuid: str
    relative_path: str  # relative to the profile destination root


@dataclass
class SkippedNode:
    """A selected node the provider could not materialize (skip report)."""

    node_uuid: str
    title: str
    reason: str


@dataclass
class ExportManifest:
    """Provider output: desired files plus the skip report."""

    files: list[ExportFile] = field(default_factory=list)
    skipped: list[SkippedNode] = field(default_factory=list)


@runtime_checkable
class ExportServices(Protocol):
    """Services injected into providers and the engine by the host."""

    async def select_node_ids(self, query: dict[str, Any]) -> list[str]:
        """Resolve a profile query (AST or saved-query ref) to node UUIDs."""
        ...

    async def build_node_contexts(self, node_uuids: list[str]) -> list[ExportNodeContext]:
        """Build provider-facing contexts for the selected nodes."""
        ...

    async def open_asset_stream(self, asset_uuid: str) -> BinaryIO | None:
        """Open a readable stream for an asset's bytes, or None if missing."""
        ...

    async def get_asset_metadata(self, asset_uuid: str) -> ExportAttachment | None:
        """Return metadata for an asset, or None when unknown."""
        ...

    async def resolve_class_names(self, node_uuid: str) -> list[str]:
        """Return the node's class names, most specific first."""
        ...


@runtime_checkable
class ExportProvider(Protocol):
    """Export provider contract (Decision 31).

    Implementations must be deterministic: the same config + nodes must yield
    the same manifest, so repeated resolutions produce byte-identical trees.
    """

    id: str

    def generate_manifest(
        self,
        config: dict[str, Any],
        nodes: list[ExportNodeContext],
        services: ExportServices,
    ) -> ExportManifest:
        """Return the desired file manifest for the resolved selection.

        ``config`` is the profile's opaque ``provider_config``. Providers
        never touch the filesystem.
        """
        ...
