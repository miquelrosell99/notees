"""Tests for the EPUB asset-metadata plugin and core orchestration.

Builds a real EPUB fixture in-test (zipfile + OPF) and exercises both the
stream-level handler (OPF read/write, cover) and the core
:class:`AssetMetadataService` flow over an in-memory WorkspaceStore: extract →
source properties, inject → blob replacement under CAS with stable asset-node
identity, idempotency, and user-schema-gated extras (Decision 29).
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from io import BytesIO

import pytest
import pytest_asyncio
from PIL import Image

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.features.assets.metadata.service import (
    AssetMetadataNotSupportedError,
    AssetMetadataService,
    split_creator_name,
)
from app.features.assets.service import AssetService
from app.plugins.builtin.epub.handler import EPUB_MIME_TYPE, EpubMetadataHandler
from app.plugins.builtin.epub.opf import read_cover, read_metadata, write_metadata
from app.plugins.core.metadata import AssetMetadataError
from app.plugins.core.registry import PluginRegistry
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit

WS = "ws-1"
ACTOR = "actor-1"

ATTACHMENTS = SYSTEM_PROPERTY_UUIDS["attachments"]
AUTHORS = SYSTEM_PROPERTY_UUIDS["authors"]
COVER = SYSTEM_PROPERTY_UUIDS["cover"]
PUBLISHER = SYSTEM_PROPERTY_UUIDS["publisher"]
ISBN = SYSTEM_PROPERTY_UUIDS["isbn"]
DOI = SYSTEM_PROPERTY_UUIDS["doi"]
PUB_DATE = SYSTEM_PROPERTY_UUIDS["publication_date"]


def _png_bytes(color: tuple[int, int, int] = (200, 100, 50)) -> bytes:
    out = BytesIO()
    Image.new("RGB", (12, 18), color).save(out, "PNG")
    return out.getvalue()


COVER_PNG = _png_bytes()
OTHER_PNG = _png_bytes((10, 20, 200))

_CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

_OPF_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:opf="http://www.idpf.org/2007/opf"
         unique-identifier="bookid" version="3.0">
  <metadata>
    <dc:identifier id="bookid">urn:uuid:test-book</dc:identifier>
    {isbn_identifier}
    {doi_identifier}
    <dc:title>{title}</dc:title>
    {creators}
    {publisher}
    {date}
    <dc:language>{language}</dc:language>
    {series_meta}
    {cover_meta}
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    {cover_item}
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>
"""

_CHAPTER = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Chapter text.</p></body></html>
"""


def build_epub(
    *,
    title: str = "Dune",
    creators: tuple[str, ...] = ("Frank Herbert",),
    publisher: str | None = "Chilton Books",
    date: str | None = "1965",
    isbn: str | None = "9780441172719",
    doi: str | None = None,
    language: str = "en",
    series: str | None = "Dune Saga",
    cover: bytes | None = COVER_PNG,
) -> bytes:
    """Build a minimal but valid EPUB archive in memory."""
    opf = _OPF_TEMPLATE.format(
        title=title,
        creators="\n    ".join(f"<dc:creator>{c}</dc:creator>" for c in creators),
        publisher=f"<dc:publisher>{publisher}</dc:publisher>" if publisher else "",
        date=f"<dc:date>{date}</dc:date>" if date else "",
        isbn_identifier=(f'<dc:identifier opf:scheme="ISBN">{isbn}</dc:identifier>' if isbn else ""),
        doi_identifier=(f"<dc:identifier>urn:doi:{doi}</dc:identifier>" if doi else ""),
        language=language,
        series_meta=(f'<meta name="calibre:series" content="{series}"/>' if series else ""),
        cover_meta='<meta name="cover" content="cover-img"/>' if cover else "",
        cover_item=('<item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>')
        if cover
        else "",
    )

    out = BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", _CONTAINER_XML)
        zf.writestr("OEBPS/content.opf", opf)
        zf.writestr("OEBPS/chapter1.xhtml", _CHAPTER)
        if cover:
            zf.writestr("OEBPS/cover.png", cover)
    return out.getvalue()


# ── Stream-level handler tests ──────────────────────────────────────────────


class TestEpubHandler:
    def test_extract_reads_opf_metadata(self) -> None:
        metadata = read_metadata(build_epub(doi="10.1000/dune"))
        assert metadata["title"] == "Dune"
        assert metadata["authors"] == ["Frank Herbert"]
        assert metadata["publisher"] == "Chilton Books"
        assert metadata["publication_date"] == "1965"
        assert metadata["isbn"] == "9780441172719"
        assert metadata["doi"] == "10.1000/dune"
        assert metadata["language"] == "en"
        assert metadata["series"] == "Dune Saga"

    def test_extract_cover_returns_image_bytes(self) -> None:
        handler = EpubMetadataHandler()
        cover = handler.extract_cover(BytesIO(build_epub()))
        assert cover is not None
        assert cover.read() == COVER_PNG
        assert handler.extract_cover(BytesIO(build_epub(cover=None))) is None

    def test_inject_writes_system_fields(self) -> None:
        handler = EpubMetadataHandler()
        out = handler.inject(
            BytesIO(build_epub()),
            {
                "title": "Dune Messiah",
                "authors": ["Frank Herbert", "Brian Herbert"],
                "publisher": "Ace Books",
                "isbn": "9780441172696",
                "doi": "10.1000/messiah",
                "language": "fr",
                "series": "Dune Chronicles",
            },
        )
        metadata = read_metadata(out.read())
        assert metadata["title"] == "Dune Messiah"
        assert metadata["authors"] == ["Frank Herbert", "Brian Herbert"]
        assert metadata["publisher"] == "Ace Books"
        assert metadata["isbn"] == "9780441172696"
        assert metadata["doi"] == "10.1000/messiah"
        assert metadata["language"] == "fr"
        assert metadata["series"] == "Dune Chronicles"

    def test_inject_is_byte_idempotent(self) -> None:
        data = build_epub()
        props = {"title": "Dune Messiah", "authors": ["Frank Herbert"]}
        once = write_metadata(data, props, OTHER_PNG)
        twice = write_metadata(once, props, OTHER_PNG)
        assert once == twice

    def test_inject_cover_replaces_embedded_image(self) -> None:
        out = write_metadata(build_epub(), {"title": "Dune"}, OTHER_PNG)
        assert read_cover(out) == OTHER_PNG

    def test_inject_without_cover_keeps_existing(self) -> None:
        out = write_metadata(build_epub(), {"title": "Dune"}, None)
        assert read_cover(out) == COVER_PNG

    def test_invalid_bytes_raise_metadata_error(self) -> None:
        with pytest.raises(AssetMetadataError):
            read_metadata(b"not a zip")

    def test_split_creator_name(self) -> None:
        assert split_creator_name("Frank Herbert") == {
            "given_name": "Frank",
            "family_name": "Herbert",
        }
        assert split_creator_name("Herbert, Frank") == {
            "given_name": "Frank",
            "family_name": "Herbert",
        }
        assert split_creator_name("Plato") == {"given_name": "", "family_name": "Plato"}


# ── Core orchestration over WorkspaceStore ──────────────────────────────────


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(self, workspace_id: str, secret_key: str) -> bytes:
        return b"0" * 32


@pytest_asyncio.fixture
async def harness(tmp_path):
    relay = SqliteRelayStorage(":memory:")
    store = WorkspaceStore(
        workspace_id=WS,
        actor_id=ACTOR,
        relay_storage=relay,
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )
    asset_service = AssetService(WS, ACTOR, store, assets_dir=tmp_path / "assets")
    registry = PluginRegistry()
    registry.add_asset_metadata_handler("notees.epub", EpubMetadataHandler())
    service = AssetMetadataService(store, asset_service, registry=registry)

    yield store, asset_service, service

    await store.close()


async def _make_source_with_epub(store: WorkspaceStore, asset_service: AssetService, epub: bytes) -> tuple[str, str]:
    """Create a source page with an EPUB attachment; return (source, asset)."""
    source_uuid = uuidv7()
    await store.create_node(
        source_uuid,
        "page",
        initial_content=[{"type": "paragraph", "children": [{"text": "dune"}]}],
        class_ids=[SYSTEM_CLASS_UUIDS["book"]],
    )
    asset = await asset_service.upload_asset(file_bytes=epub, filename="dune.epub", content_type=EPUB_MIME_TYPE)
    await store.set_property(
        property_value_id=uuidv7(),
        node_id=source_uuid,
        schema_id=ATTACHMENTS,
        value=asset["uuid"],
    )
    await store.sync()
    return source_uuid, asset["uuid"]


async def _props(store: WorkspaceStore, node_uuid: str) -> dict[str, list]:
    rows = await store.query(
        "SELECT property_schema_id, idx, value FROM property_value WHERE node_id = ? ORDER BY property_schema_id, idx",
        (node_uuid,),
    )
    result: dict[str, list] = {}
    for row in rows:
        result.setdefault(row["property_schema_id"], []).append(json.loads(row["value"]))
    return result


async def _node_text(store: WorkspaceStore, node_uuid: str) -> str | None:
    rows = await store.query("SELECT content FROM node WHERE id = ?", (node_uuid,))
    if not rows:
        return None
    content = json.loads(rows[0]["content"])
    return "".join(child.get("text", "") for child in content[0].get("children", []))


class TestAssetMetadataService:
    async def test_extract_populates_source(self, harness) -> None:
        store, _, service = harness
        source_uuid, asset_uuid = await _make_source_with_epub(
            store, service._asset_service, build_epub(doi="10.1000/dune")
        )

        result = await service.apply_extract_to_source(asset_uuid, source_uuid)

        assert result["applied"]["title"] == "Dune"
        assert result["applied"]["authors"] == ["Frank Herbert"]
        assert result["applied"]["publisher"] == "Chilton Books"

        assert await _node_text(store, source_uuid) == "Dune"
        props = await _props(store, source_uuid)
        assert props[PUBLISHER] == ["Chilton Books"]
        assert props[ISBN] == ["9780441172719"]
        assert props[DOI] == ["10.1000/dune"]
        assert props[PUB_DATE] == ["1965"]

        # Authors resolve to find-or-create person agent nodes.
        author_uuid = props[AUTHORS][0]
        assert await _node_text(store, author_uuid) == "Frank Herbert"
        author_rows = await store.query("SELECT class_ids FROM node WHERE id = ?", (author_uuid,))
        assert SYSTEM_CLASS_UUIDS["person"] in json.loads(author_rows[0]["class_ids"])

    async def test_extract_sets_cover_from_epub(self, harness) -> None:
        store, _, service = harness
        source_uuid, asset_uuid = await _make_source_with_epub(store, service._asset_service, build_epub())

        result = await service.apply_extract_to_source(asset_uuid, source_uuid)

        props = await _props(store, source_uuid)
        cover_uuid = props[COVER][0]
        assert result["applied"]["cover"] == cover_uuid
        rows = await store.query("SELECT asset_hash FROM node_asset WHERE node_id = ?", (cover_uuid,))
        assert rows[0]["asset_hash"] == hashlib.sha256(COVER_PNG).hexdigest()

        # Re-extracting does not pile up duplicate cover assets.
        await service.apply_extract_to_source(asset_uuid, source_uuid)
        rows = await store.query(
            "SELECT node_id FROM node_asset WHERE asset_hash = ?",
            (hashlib.sha256(COVER_PNG).hexdigest(),),
        )
        assert len(rows) == 1

    async def test_extras_round_trip_only_with_user_schema(self, harness) -> None:
        store, _, service = harness
        # User-defined "language" schema exists; no "series" schema (Decision 29).
        language_schema = uuidv7()
        await store.create_property_schema(schema_id=language_schema, name="language", prop_type="text")
        source_uuid, asset_uuid = await _make_source_with_epub(store, service._asset_service, build_epub())

        result = await service.apply_extract_to_source(asset_uuid, source_uuid)
        assert result["applied"]["language"] == "en"
        assert "series" not in result["applied"]
        props = await _props(store, source_uuid)
        assert props[language_schema] == ["en"]

        # Inject writes the extra field back into the OPF.
        inject = await service.inject_from_source(asset_uuid, source_uuid)
        assert inject["changed"] is True
        new_bytes = service._read_blob(inject["asset_hash"])
        metadata = read_metadata(new_bytes)
        assert metadata["language"] == "en"
        # No user schema for series → the source has nothing to write; the
        # OPF's original series value is preserved, never synced.
        assert metadata["series"] == "Dune Saga"

    async def test_extras_inject_updates_existing_opf_field(self, harness) -> None:
        store, _, service = harness
        series_schema = uuidv7()
        await store.create_property_schema(schema_id=series_schema, name="series", prop_type="text")
        source_uuid, asset_uuid = await _make_source_with_epub(store, service._asset_service, build_epub())
        await store.set_property(
            property_value_id=uuidv7(),
            node_id=source_uuid,
            schema_id=series_schema,
            value="Dune Chronicles",
        )

        inject = await service.inject_from_source(asset_uuid, source_uuid)
        metadata = read_metadata(service._read_blob(inject["asset_hash"]))
        assert metadata["series"] == "Dune Chronicles"

    async def test_inject_replaces_blob_and_keeps_node_identity(self, harness) -> None:
        store, _, service = harness
        source_uuid, asset_uuid = await _make_source_with_epub(store, service._asset_service, build_epub())
        old_hash = hashlib.sha256(build_epub()).hexdigest()

        # Edit the title on the source, then sync it into the EPUB.
        await store.update_content(source_uuid, [{"type": "paragraph", "children": [{"text": "Dune Messiah"}]}])
        result = await service.inject_from_source(asset_uuid, source_uuid)

        assert result["changed"] is True
        assert result["asset_uuid"] == asset_uuid
        assert result["asset_hash"] != old_hash

        rows = await store.query("SELECT asset_hash FROM node_asset WHERE node_id = ?", (asset_uuid,))
        assert [row["asset_hash"] for row in rows] == [result["asset_hash"]]

        new_bytes = service._read_blob(result["asset_hash"])
        assert read_metadata(new_bytes)["title"] == "Dune Messiah"

        # The old blob is dropped through normal CAS reference counting.
        assert service._asset_service.file_service.find_source_file(old_hash) is None

        # Injecting unchanged metadata is a no-op.
        again = await service.inject_from_source(asset_uuid, source_uuid)
        assert again["changed"] is False
        assert again["asset_hash"] == result["asset_hash"]

    async def test_inject_embeds_source_cover(self, harness) -> None:
        store, asset_service, service = harness
        source_uuid, asset_uuid = await _make_source_with_epub(store, asset_service, build_epub())

        # Point the source's cover property at a new image asset.
        cover_asset = await asset_service.upload_asset(
            file_bytes=OTHER_PNG, filename="cover.png", content_type="image/png"
        )
        await store.set_property(
            property_value_id=uuidv7(),
            node_id=source_uuid,
            schema_id=COVER,
            value=cover_asset["uuid"],
        )

        result = await service.inject_from_source(asset_uuid, source_uuid)
        new_bytes = service._read_blob(result["asset_hash"])
        assert read_cover(new_bytes) == OTHER_PNG

    async def test_find_referencing_sources(self, harness) -> None:
        store, _, service = harness
        source_uuid, asset_uuid = await _make_source_with_epub(store, service._asset_service, build_epub())
        assert await service.find_referencing_sources(asset_uuid) == [source_uuid]
        assert await service.find_referencing_sources(uuidv7()) == []

    async def test_unsupported_mime_raises(self, harness) -> None:
        store, asset_service, service = harness
        asset = await asset_service.upload_asset(
            file_bytes=b"%PDF-1.4 fake", filename="paper.pdf", content_type="application/pdf"
        )
        source_uuid = uuidv7()
        await store.create_node(source_uuid, "page")
        with pytest.raises(AssetMetadataNotSupportedError):
            await service.apply_extract_to_source(asset["uuid"], source_uuid)
        with pytest.raises(AssetMetadataNotSupportedError):
            await service.inject_from_source(asset["uuid"], source_uuid)
