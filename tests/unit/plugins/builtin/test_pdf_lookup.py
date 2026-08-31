"""Tests for the add-by-file (PDF lookup) flow — Task 14.

PDF fixtures are generated in-test with pypdf (no binary fixtures on disk).
All provider HTTP is mocked via ``httpx.MockTransport`` — no real network.
"""

from __future__ import annotations

import io
import json
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException, UploadFile
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.features.assets.service import AssetService
from app.plugins.builtin.library import router as library_router
from app.plugins.builtin.library.lookup import CrossrefProvider
from app.plugins.builtin.library.pdf import (
    PdfExtractionError,
    extract_pdf_identifiers,
)
from app.plugins.builtin.library.router import ROLE_REPRESENTATION_OPTION_UUID
from app.plugins.core.context import PluginContext
from app.plugins.core.registry import PluginRegistry
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit

WS = "ws-1"
ACTOR = "actor-1"


# ---------------------------------------------------------------------------
# In-test PDF generation
# ---------------------------------------------------------------------------

_XMP_TEMPLATE = """<?xpacket begin="\\xef\\xbb\\xbf" id="W"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
   {fields}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""


def build_pdf(
    lines: list[tuple[int, str]] | None = None,
    *,
    info: dict[str, str] | None = None,
    xmp_doi: str | None = None,
    xmp_title: str | None = None,
) -> bytes:
    """Build a minimal one-page PDF; ``lines`` are (font size, text) pairs."""
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    if lines:
        ops = []
        y = 760
        for size, text in lines:
            escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            ops.append(f"BT /F1 {size} Tf 72 {y} Td ({escaped}) Tj ET")
            y -= 30
        content = DecodedStreamObject()
        content.set_data(" ".join(ops).encode())
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
        page[NameObject("/Contents")] = content
    if info:
        writer.add_metadata(info)
    if xmp_doi or xmp_title:
        fields = ""
        if xmp_title:
            fields += f'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">{xmp_title}</rdf:li></rdf:Alt></dc:title>'
        if xmp_doi:
            fields += f"<prism:doi>{xmp_doi}</prism:doi>"
        stream = DecodedStreamObject()
        stream.set_data(_XMP_TEMPLATE.format(fields=fields).encode())
        stream[NameObject("/Type")] = NameObject("/Metadata")
        stream[NameObject("/Subtype")] = NameObject("/XML")
        writer._root_object[NameObject("/Metadata")] = writer._add_object(stream)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


class TestExtractPdfIdentifiers:
    def test_doi_and_title_from_xmp(self) -> None:
        data = build_pdf([(10, "body text")], xmp_doi="10.1000/xmpdoi", xmp_title="XMP Title")
        result = extract_pdf_identifiers(data)
        assert result.doi == "10.1000/xmpdoi"
        assert result.title_hint == "XMP Title"
        assert result.identifier == ("doi", "10.1000/xmpdoi")

    def test_doi_from_text_and_prominent_title(self) -> None:
        data = build_pdf([(24, "Wnt signalling in stem cells"), (10, "doi: 10.1038/nature12373.")])
        result = extract_pdf_identifiers(data)
        assert result.doi == "10.1038/nature12373"  # trailing period stripped
        assert result.title_hint == "Wnt signalling in stem cells"

    def test_doi_from_info_dict_subject(self) -> None:
        data = build_pdf([(10, "body")], info={"/Subject": "doi:10.5555/subject.doi"})
        result = extract_pdf_identifiers(data)
        assert result.doi == "10.5555/subject.doi"

    def test_title_from_info_dict(self) -> None:
        data = build_pdf([(10, "body")], info={"/Title": "Info Dict Title"})
        result = extract_pdf_identifiers(data)
        assert result.title_hint == "Info Dict Title"

    def test_isbn_from_text(self) -> None:
        data = build_pdf([(18, "Dune"), (10, "ISBN 978-0-441-17271-9")])
        result = extract_pdf_identifiers(data)
        assert result.isbn == "9780441172719"
        assert result.identifier == ("isbn", "9780441172719")

    def test_doi_preferred_over_isbn(self) -> None:
        data = build_pdf([(10, "ISBN 9780441172719, doi 10.1000/xyz")])
        result = extract_pdf_identifiers(data)
        assert result.identifier == ("doi", "10.1000/xyz")

    def test_no_identifiers(self) -> None:
        data = build_pdf([(12, "ordinary prose without any identifier")])
        result = extract_pdf_identifiers(data)
        assert result.doi is None
        assert result.isbn is None
        assert result.identifier is None

    def test_not_a_pdf(self) -> None:
        with pytest.raises(PdfExtractionError):
            extract_pdf_identifiers(b"this is not a pdf at all")


# ---------------------------------------------------------------------------
# Router harness
# ---------------------------------------------------------------------------


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(self, workspace_id: str, secret_key: str) -> bytes:
        return b"0" * 32


class FakeSettingsRepository:
    def __init__(self, store: dict) -> None:
        self._store = store

    async def get_workspace_settings(self, workspace_id: int) -> dict:
        return dict(self._store)

    async def set_workspace_setting(self, workspace_id: int, key: str, value, updated_at, user_id: int) -> None:
        self._store[key] = value


@pytest_asyncio.fixture
async def harness(tmp_path):
    """PluginContext + WorkspaceStore + AssetService sharing one relay."""
    relay = SqliteRelayStorage(":memory:")
    settings: dict = {}

    async def workspace_store_factory(workspace_uuid: str, actor_uuid: str) -> WorkspaceStore:
        return WorkspaceStore(
            workspace_id=workspace_uuid,
            actor_id=actor_uuid,
            relay_storage=relay,
            db_path=":memory:",
            key_storage=FixedKeyStorage(),
        )

    async def settings_factory(workspace_id: int, user_id: int):
        return FakeSettingsRepository(settings)

    context = PluginContext(
        plugin_id="notees.library",
        permissions={
            "read_nodes",
            "write_nodes",
            "read_properties",
            "write_properties",
            "settings",
            "router",
        },
        registry=PluginRegistry(),
        port_factories={
            "WorkspaceStore": workspace_store_factory,
            "SettingsRepository": settings_factory,
        },
    )

    store = WorkspaceStore(
        workspace_id=WS,
        actor_id=ACTOR,
        relay_storage=relay,
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )
    await store.sync()
    asset_service = AssetService(WS, ACTOR, store, assets_dir=tmp_path / "assets")

    previous = library_router.runtime.context
    library_router.runtime.context = context

    ctx = SimpleNamespace(workspace_uuid=WS, user_uuid=ACTOR, workspace_id=1, user_id=1)

    yield store, asset_service, ctx

    library_router.runtime.context = previous
    await store.close()


def _upload(data: bytes, filename: str = "paper.pdf") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=filename)


def _crossref_client(**overrides) -> httpx.AsyncClient:
    message = {
        "DOI": "10.1038/nature12373",
        "title": ["Wnt signalling in stem cells"],
        "author": [{"given": "Jane", "family": "Doe"}],
        "issued": {"date-parts": [[2013, 7, 4]]},
        "publisher": "Nature Publishing Group",
        "type": "journal-article",
    }
    message.update(overrides)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "ok", "message": message})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _patch_provider(monkeypatch: pytest.MonkeyPatch, client: httpx.AsyncClient) -> None:
    monkeypatch.setattr(
        library_router,
        "provider_for_kind",
        lambda kind: CrossrefProvider(http_client=client),
    )


async def _props(store: WorkspaceStore, node_uuid: str) -> dict[str, list]:
    rows = await store.query(
        "SELECT property_schema_id, idx, value FROM property_value WHERE node_id = ? ORDER BY property_schema_id, idx",
        (node_uuid,),
    )
    result: dict[str, list] = {}
    for row in rows:
        result.setdefault(row["property_schema_id"], []).append(json.loads(row["value"]))
    return result


DOI_PDF = None  # built lazily per test via build_pdf


class TestInspectPdf:
    async def test_resolves_doi_to_metadata(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_provider(monkeypatch, _crossref_client())
        data = build_pdf([(24, "Some Title"), (10, "doi: 10.1038/nature12373")])
        response = await library_router.inspect_pdf(file=_upload(data), user=None)

        assert response["identifiers"]["doi"] == "10.1038/nature12373"
        assert response["suggested_title"] == "Some Title"
        metadata = response["metadata"]
        assert metadata["title"] == "Wnt signalling in stem cells"
        assert metadata["provider"] == "crossref"

    async def test_no_identifiers_returns_fallback(self) -> None:
        # A text-less PDF (e.g. a scan) has no title hint either, so the
        # suggested title falls back to the filename.
        data = build_pdf()
        response = await library_router.inspect_pdf(file=_upload(data, "my paper_draft.pdf"), user=None)

        assert response["metadata"] is None
        assert response["identifiers"]["doi"] is None
        assert response["suggested_title"] == "my paper draft"

    async def test_provider_down_is_502(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"status": "failed"})

        _patch_provider(monkeypatch, httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        data = build_pdf([(10, "doi: 10.1038/nature12373")])
        with pytest.raises(HTTPException) as excinfo:
            await library_router.inspect_pdf(file=_upload(data), user=None)
        assert excinfo.value.status_code == 502

    async def test_unknown_doi_is_404(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"status": "failed"})

        _patch_provider(monkeypatch, httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        data = build_pdf([(10, "doi: 10.1000/nonexistent")])
        with pytest.raises(HTTPException) as excinfo:
            await library_router.inspect_pdf(file=_upload(data), user=None)
        assert excinfo.value.status_code == 404

    async def test_non_pdf_is_400(self) -> None:
        with pytest.raises(HTTPException) as excinfo:
            await library_router.inspect_pdf(file=_upload(b"not a pdf"), user=None)
        assert excinfo.value.status_code == 400


class TestCreateSourceFromPdf:
    async def test_populated_source_with_attachment(self, harness) -> None:
        store, asset_service, ctx = harness
        data = build_pdf([(24, "Wnt signalling"), (10, "body")])

        result = await library_router.create_source_from_pdf(
            ctx=ctx,
            store=store,
            asset_service=asset_service,
            file=_upload(data),
            title="Wnt signalling in stem cells",
            class_name="paper",
            creators=json.dumps([{"given_name": "Jane", "family_name": "Doe"}]),
            publication_date="2013-07-04",
            publisher="Nature Publishing Group",
            isbn=None,
            doi="10.1038/nature12373",
            attach=True,
        )

        assert result["needs_metadata"] is False
        node_uuid = result["node_uuid"]
        asset_uuid = result["asset_uuid"]
        assert asset_uuid is not None

        await store.sync()
        rows = await store.query("SELECT class_ids, content FROM node WHERE id = ?", (node_uuid,))
        assert json.loads(rows[0]["class_ids"]) == [SYSTEM_CLASS_UUIDS["paper"]]

        props = await _props(store, node_uuid)
        assert props[SYSTEM_PROPERTY_UUIDS["doi"]] == ["10.1038/nature12373"]
        assert props[SYSTEM_PROPERTY_UUIDS["attachments"]] == [asset_uuid]
        assert props[SYSTEM_PROPERTY_UUIDS["citekey"]] == ["doe2013"]

        asset_rows = await store.query(
            "SELECT mime_type, original_name FROM node_asset WHERE node_id = ?", (asset_uuid,)
        )
        assert asset_rows[0]["mime_type"] == "application/pdf"
        assert asset_rows[0]["original_name"] == "paper.pdf"
        asset_props = await _props(store, asset_uuid)
        assert asset_props[SYSTEM_PROPERTY_UUIDS["role"]] == [ROLE_REPRESENTATION_OPTION_UUID]

    async def test_fallback_without_identifiers(self, harness) -> None:
        store, asset_service, ctx = harness
        data = build_pdf([(12, "no identifiers here")])

        result = await library_router.create_source_from_pdf(
            ctx=ctx,
            store=store,
            asset_service=asset_service,
            file=_upload(data, "scan.pdf"),
            title="scan",
            class_name="document",
            creators="[]",
            publication_date=None,
            publisher=None,
            isbn=None,
            doi=None,
            attach=True,
        )

        assert result["needs_metadata"] is True
        await store.sync()
        props = await _props(store, result["node_uuid"])
        assert props[SYSTEM_PROPERTY_UUIDS["attachments"]] == [result["asset_uuid"]]
        assert SYSTEM_PROPERTY_UUIDS["doi"] not in props

    async def test_attach_false_creates_no_asset(self, harness) -> None:
        store, asset_service, ctx = harness
        data = build_pdf([(12, "body")])

        result = await library_router.create_source_from_pdf(
            ctx=ctx,
            store=store,
            asset_service=asset_service,
            file=_upload(data),
            title="No attach",
            class_name="document",
            creators="[]",
            publication_date=None,
            publisher=None,
            isbn=None,
            doi=None,
            attach=False,
        )

        assert result["asset_uuid"] is None
        await store.sync()
        props = await _props(store, result["node_uuid"])
        assert SYSTEM_PROPERTY_UUIDS["attachments"] not in props

    async def test_attach_failure_rolls_back_source(self, harness, monkeypatch: pytest.MonkeyPatch) -> None:
        store, asset_service, ctx = harness
        data = build_pdf([(12, "body")])

        async def failing_upload(**kwargs):
            raise RuntimeError("disk full")

        monkeypatch.setattr(asset_service, "upload_asset", failing_upload)

        with pytest.raises(HTTPException) as excinfo:
            await library_router.create_source_from_pdf(
                ctx=ctx,
                store=store,
                asset_service=asset_service,
                file=_upload(data),
                title="Doomed",
                class_name="document",
                creators="[]",
                publication_date=None,
                publisher=None,
                isbn=None,
                doi=None,
                attach=True,
            )
        assert excinfo.value.status_code == 500

        await store.sync()
        rows = await store.query("SELECT id FROM node WHERE active = 1")
        assert rows == []

    async def test_invalid_class_is_400(self, harness) -> None:
        store, asset_service, ctx = harness
        data = build_pdf([(12, "body")])
        with pytest.raises(HTTPException) as excinfo:
            await library_router.create_source_from_pdf(
                ctx=ctx,
                store=store,
                asset_service=asset_service,
                file=_upload(data),
                title="X",
                class_name="not-a-class",
                creators="[]",
                publication_date=None,
                publisher=None,
                isbn=None,
                doi=None,
                attach=True,
            )
        assert excinfo.value.status_code == 400

    async def test_non_pdf_is_400(self, harness) -> None:
        store, asset_service, ctx = harness
        with pytest.raises(HTTPException) as excinfo:
            await library_router.create_source_from_pdf(
                ctx=ctx,
                store=store,
                asset_service=asset_service,
                file=_upload(b"definitely not a pdf"),
                title="X",
                class_name="document",
                creators="[]",
                publication_date=None,
                publisher=None,
                isbn=None,
                doi=None,
                attach=True,
            )
        assert excinfo.value.status_code == 400
