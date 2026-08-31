"""Asset Metadata Plugin API (Decision 30).

Format plugins (EPUB, PDF, …) register one handler per MIME type. Handlers
operate purely on **streams**: they never touch the filesystem, CAS storage
paths, or hashing — the core owns storage, hashing, and ``blob_ref`` updates
(see ``app/features/assets/metadata/service.py``).

The metadata dictionaries use plain property names:

- ``title``: ``str`` — maps to the source node's content (its name).
- ``authors``: ``list[str]`` — creator display names; the core resolves them
  to ``person``/``organization`` agent nodes for the system ``authors``
  property.
- ``publisher``, ``publication_date``, ``isbn``, ``doi``: ``str`` — map to the
  same-named system properties bound to ``source``.
- Any other key is an *extra* field (e.g. ``language``, ``series``). Extras
  round-trip to same-named **user-defined** property schemas only when such a
  schema exists; the plugin never creates schemas (Decision 29).

Inject direction (``inject``) receives the same dictionary built from the
source node, restricted to keys the handler declares via
:attr:`AssetMetadataHandler.extra_fields` plus the system keys above.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, BinaryIO, ClassVar

# System keys every handler may use; anything else is an extra field.
SYSTEM_METADATA_KEYS = ("title", "authors", "publisher", "publication_date", "isbn", "doi")


class AssetMetadataError(Exception):
    """Raised when a handler cannot parse or rewrite an asset blob."""


class AssetMetadataHandler(ABC):
    """Backend adapter reading/writing metadata inside an asset file."""

    #: MIME types this handler is registered for (e.g. ``["application/epub+zip"]``).
    mime_types: ClassVar[list[str]] = []
    #: Extra (non-system) field names the handler can round-trip. The core only
    #: passes/sets extras whose same-named user property schema exists.
    extra_fields: ClassVar[list[str]] = []

    @abstractmethod
    def extract(self, stream: BinaryIO) -> dict[str, Any]:
        """Read the blob and return the metadata dictionary."""

    @abstractmethod
    def inject(
        self,
        stream: BinaryIO,
        properties: dict[str, Any],
        cover_stream: BinaryIO | None = None,
    ) -> BinaryIO:
        """Return a new stream of the blob with ``properties`` written into it.

        Must be idempotent: injecting the same properties twice yields
        byte-identical output (the core dedupes by content hash).
        """

    @abstractmethod
    def extract_cover(self, stream: BinaryIO) -> BinaryIO | None:
        """Return a stream with the embedded cover image, or None."""
