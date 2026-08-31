"""EPUB metadata handler for the Asset Metadata Plugin API."""

from __future__ import annotations

from io import BytesIO
from typing import Any, BinaryIO, ClassVar

from app.plugins.core.metadata import AssetMetadataHandler

from .opf import read_cover, read_metadata, write_metadata

EPUB_MIME_TYPE = "application/epub+zip"


class EpubMetadataHandler(AssetMetadataHandler):
    """Read/write OPF metadata and cover images in EPUB files."""

    mime_types: ClassVar[list[str]] = [EPUB_MIME_TYPE]
    extra_fields: ClassVar[list[str]] = ["language", "series"]

    def extract(self, stream: BinaryIO) -> dict[str, Any]:
        return read_metadata(stream.read())

    def inject(
        self,
        stream: BinaryIO,
        properties: dict[str, Any],
        cover_stream: BinaryIO | None = None,
    ) -> BinaryIO:
        cover_bytes = cover_stream.read() if cover_stream is not None else None
        return BytesIO(write_metadata(stream.read(), properties, cover_bytes))

    def extract_cover(self, stream: BinaryIO) -> BinaryIO | None:
        cover = read_cover(stream.read())
        return BytesIO(cover) if cover is not None else None
