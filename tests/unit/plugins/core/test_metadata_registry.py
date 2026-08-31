"""Registry coverage for MIME-registered asset metadata handlers (Decision 30)."""

from typing import Any, BinaryIO, ClassVar

import pytest

from app.plugins.core.metadata import AssetMetadataHandler
from app.plugins.core.registry import PluginRegistry


class _FakeHandler(AssetMetadataHandler):
    mime_types: ClassVar[list[str]] = ["application/x-fake", "application/x-fake2"]

    def extract(self, stream: BinaryIO) -> dict[str, Any]:
        return {}

    def inject(self, stream, properties, cover_stream=None):
        return stream

    def extract_cover(self, stream: BinaryIO) -> BinaryIO | None:
        return None


@pytest.mark.unit
def test_asset_metadata_handler_registered_per_mime_type() -> None:
    registry = PluginRegistry()
    handler = _FakeHandler()

    registry.add_asset_metadata_handler("notees.fake", handler)

    for mime in handler.mime_types:
        entry = registry.get_asset_metadata_handler(mime)
        assert entry == ("notees.fake", handler)
    assert registry.list_asset_metadata_handlers() == [handler]


@pytest.mark.unit
def test_remove_asset_metadata_handlers_by_plugin() -> None:
    registry = PluginRegistry()
    handler = _FakeHandler()
    registry.add_asset_metadata_handler("notees.fake", handler)

    removed = registry.remove_asset_metadata_handlers("notees.fake")

    assert removed == [handler]
    assert registry.get_asset_metadata_handler("application/x-fake") is None
    assert registry.list_asset_metadata_handlers() == []
