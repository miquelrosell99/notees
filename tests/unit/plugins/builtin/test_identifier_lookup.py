"""Tests for the add-by-identifier lookup providers and create pipeline (Task 13).

All HTTP is mocked via ``httpx.MockTransport`` — no real network access.
"""

from __future__ import annotations

import json

import httpx
import pytest
import pytest_asyncio

from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.builtin.library.lookup import (
    CrossrefProvider,
    InvalidIdentifierError,
    MetadataNotFoundError,
    MetadataProviderUnavailableError,
    OpenLibraryProvider,
    classify_identifier,
)
from app.plugins.builtin.library.pipeline import create_source_from_metadata
from app.plugins.core.context import PluginContext
from app.plugins.core.registry import PluginRegistry
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit

WS = "ws-1"
ACTOR = "actor-1"


class TestClassifyIdentifier:
    def test_plain_doi(self) -> None:
        assert classify_identifier("10.1038/nature12373") == ("doi", "10.1038/nature12373")

    def test_doi_url(self) -> None:
        assert classify_identifier("https://doi.org/10.1038/nature12373") == (
            "doi",
            "10.1038/nature12373",
        )

    def test_doi_prefix(self) -> None:
        assert classify_identifier("doi:10.1000/xyz") == ("doi", "10.1000/xyz")

    def test_isbn13_with_hyphens(self) -> None:
        assert classify_identifier("978-0-441-17271-9") == ("isbn", "9780441172719")

    def test_isbn10_with_x(self) -> None:
        assert classify_identifier("0-8044-2957-X") == ("isbn", "080442957X")

    def test_invalid_identifier(self) -> None:
        with pytest.raises(InvalidIdentifierError):
            classify_identifier("some random text")


def _crossref_payload(**overrides) -> dict:
    message = {
        "DOI": "10.1038/nature12373",
        "title": ["Wnt signalling in stem cells"],
        "author": [
            {"given": "Jane", "family": "Doe"},
            {"given": "John", "family": "Smith"},
            {"name": "Wnt Consortium"},
        ],
        "issued": {"date-parts": [[2013, 7, 4]]},
        "publisher": "Nature Publishing Group",
        "type": "journal-article",
        "language": "en",
    }
    message.update(overrides)
    return {"status": "ok", "message": message}


def _mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestCrossrefProvider:
    async def test_lookup_normalizes_work(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/works/10.1038/nature12373"
            return httpx.Response(200, json=_crossref_payload())

        provider = CrossrefProvider(http_client=_mock_client(handler))
        metadata = await provider.lookup("10.1038/nature12373")

        assert metadata.title == "Wnt signalling in stem cells"
        assert metadata.creators == [
            {"given_name": "Jane", "family_name": "Doe"},
            {"given_name": "John", "family_name": "Smith"},
            {"organization_name": "Wnt Consortium"},
        ]
        assert metadata.publication_date == "2013-07-04"
        assert metadata.publisher == "Nature Publishing Group"
        assert metadata.doi == "10.1038/nature12373"
        assert metadata.class_name == "paper"
        assert metadata.language == "en"
        assert metadata.provider == "crossref"

    async def test_partial_date_parts(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_crossref_payload(**{"issued": {"date-parts": [[1965]]}}))

        provider = CrossrefProvider(http_client=_mock_client(handler))
        metadata = await provider.lookup("10.1000/x")
        assert metadata.publication_date == "1965"

    @pytest.mark.parametrize(
        ("work_type", "class_name"),
        [
            ("journal-article", "paper"),
            ("proceedings-article", "paper"),
            ("posted-content", "paper"),
            ("monograph", "book"),
            ("book-chapter", "book"),
            ("dissertation", "thesis"),
            ("report", "document"),
            ("dataset", "article"),  # unmapped → default
        ],
    )
    async def test_type_mapping(self, work_type: str, class_name: str) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_crossref_payload(type=work_type))

        provider = CrossrefProvider(http_client=_mock_client(handler))
        metadata = await provider.lookup("10.1000/x")
        assert metadata.class_name == class_name

    async def test_not_found(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"status": "failed"})

        provider = CrossrefProvider(http_client=_mock_client(handler))
        with pytest.raises(MetadataNotFoundError):
            await provider.lookup("10.1000/nonexistent")

    async def test_provider_error_is_unavailable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"status": "failed"})

        provider = CrossrefProvider(http_client=_mock_client(handler))
        with pytest.raises(MetadataProviderUnavailableError):
            await provider.lookup("10.1000/x")

    async def test_network_failure_is_unavailable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        provider = CrossrefProvider(http_client=_mock_client(handler))
        with pytest.raises(MetadataProviderUnavailableError):
            await provider.lookup("10.1000/x")


def _openlibrary_edition(**overrides) -> dict:
    edition = {
        "title": "Dune",
        "publishers": ["Chilton Books"],
        "publish_date": "August 1965",
        "authors": [{"key": "/authors/OL790A"}],
        "languages": [{"key": "/languages/eng"}],
        "isbn_13": ["9780441172719"],
    }
    edition.update(overrides)
    return edition


class TestOpenLibraryProvider:
    async def test_lookup_normalizes_edition_with_authors(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/isbn/9780441172719.json":
                return httpx.Response(200, json=_openlibrary_edition())
            if request.url.path == "/authors/OL790A.json":
                return httpx.Response(200, json={"name": "Frank Herbert"})
            return httpx.Response(404, json={"error": "notfound"})

        provider = OpenLibraryProvider(http_client=_mock_client(handler))
        metadata = await provider.lookup("9780441172719")

        assert metadata.title == "Dune"
        assert metadata.creators == [{"given_name": "Frank", "family_name": "Herbert"}]
        assert metadata.publication_date == "August 1965"
        assert metadata.publisher == "Chilton Books"
        assert metadata.isbn == "9780441172719"
        assert metadata.class_name == "book"
        assert metadata.language == "eng"
        assert metadata.provider == "openlibrary"

    async def test_missing_author_record_is_skipped(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.startswith("/authors/"):
                return httpx.Response(404, json={"error": "notfound"})
            return httpx.Response(200, json=_openlibrary_edition())

        provider = OpenLibraryProvider(http_client=_mock_client(handler))
        metadata = await provider.lookup("9780441172719")
        assert metadata.title == "Dune"
        assert metadata.creators == []

    async def test_not_found(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"error": "notfound"})

        provider = OpenLibraryProvider(http_client=_mock_client(handler))
        with pytest.raises(MetadataNotFoundError):
            await provider.lookup("9780000000000")

    async def test_network_failure_is_unavailable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        provider = OpenLibraryProvider(http_client=_mock_client(handler))
        with pytest.raises(MetadataProviderUnavailableError):
            await provider.lookup("9780441172719")


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(self, workspace_id: str, secret_key: str) -> bytes:
        return b"0" * 32


class FakeSettingsRepository:
    """Dict-backed settings repository (workspace settings)."""

    def __init__(self, store: dict) -> None:
        self._store = store

    async def get_workspace_settings(self, workspace_id: int) -> dict:
        return dict(self._store)

    async def set_workspace_setting(self, workspace_id: int, key: str, value, updated_at, user_id: int) -> None:
        self._store[key] = value


@pytest_asyncio.fixture
async def harness():
    """PluginContext wired to in-memory stores, mirroring the Zotero sync tests."""
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

    async def open_store() -> WorkspaceStore:
        store = WorkspaceStore(
            workspace_id=WS,
            actor_id=ACTOR,
            relay_storage=relay,
            db_path=":memory:",
            key_storage=FixedKeyStorage(),
        )
        await store.sync()
        return store

    return context, open_store


async def _props(store: WorkspaceStore, node_uuid: str) -> dict[str, list]:
    rows = await store.query(
        "SELECT property_schema_id, idx, value FROM property_value WHERE node_id = ? ORDER BY property_schema_id, idx",
        (node_uuid,),
    )
    result: dict[str, list] = {}
    for row in rows:
        result.setdefault(row["property_schema_id"], []).append(json.loads(row["value"]))
    return result


def _dune_metadata():
    from app.plugins.builtin.library.lookup import SourceMetadata

    return SourceMetadata(
        title="Dune",
        creators=[{"given_name": "Frank", "family_name": "Herbert"}],
        publication_date="1965",
        publisher="Chilton Books",
        isbn="9780441172719",
        class_name="book",
        provider="openlibrary",
    )


class TestCreateSourceFromMetadata:
    async def test_creates_fully_populated_source(self, harness) -> None:
        context, open_store = harness
        result = await create_source_from_metadata(
            context,
            workspace_uuid=WS,
            actor_uuid=ACTOR,
            workspace_id=1,
            user_id=1,
            metadata=_dune_metadata(),
        )

        node_uuid = result["node_uuid"]
        assert result["citekey"] == "herbert1965"

        store = await open_store()
        try:
            rows = await store.query("SELECT id, class_ids, content FROM node WHERE id = ?", (node_uuid,))
            assert len(rows) == 1
            assert json.loads(rows[0]["class_ids"]) == [SYSTEM_CLASS_UUIDS["book"]]
            assert "Dune" in rows[0]["content"]

            props = await _props(store, node_uuid)
            assert props[SYSTEM_PROPERTY_UUIDS["isbn"]] == ["9780441172719"]
            assert props[SYSTEM_PROPERTY_UUIDS["publication_date"]] == ["1965"]
            assert props[SYSTEM_PROPERTY_UUIDS["publisher"]] == ["Chilton Books"]
            assert props[SYSTEM_PROPERTY_UUIDS["citekey"]] == ["herbert1965"]

            author_uuid = props[SYSTEM_PROPERTY_UUIDS["authors"]][0]
            agent_rows = await store.query("SELECT class_ids, content FROM node WHERE id = ?", (author_uuid,))
            assert json.loads(agent_rows[0]["class_ids"]) == [SYSTEM_CLASS_UUIDS["person"]]
            assert "Frank Herbert" in agent_rows[0]["content"]
            agent_props = await _props(store, author_uuid)
            assert agent_props[SYSTEM_PROPERTY_UUIDS["given_name"]] == ["Frank"]
            assert agent_props[SYSTEM_PROPERTY_UUIDS["family_name"]] == ["Herbert"]
        finally:
            await store.close()

    async def test_unknown_class_falls_back_to_document(self, harness) -> None:
        context, open_store = harness
        metadata = _dune_metadata()
        metadata.class_name = "not-a-class"
        result = await create_source_from_metadata(
            context,
            workspace_uuid=WS,
            actor_uuid=ACTOR,
            workspace_id=1,
            user_id=1,
            metadata=metadata,
        )
        store = await open_store()
        try:
            rows = await store.query("SELECT class_ids FROM node WHERE id = ?", (result["node_uuid"],))
            assert json.loads(rows[0]["class_ids"]) == [SYSTEM_CLASS_UUIDS["document"]]
        finally:
            await store.close()

    async def test_repeated_lookup_reuses_agent_nodes(self, harness) -> None:
        context, open_store = harness
        first = await create_source_from_metadata(
            context,
            workspace_uuid=WS,
            actor_uuid=ACTOR,
            workspace_id=1,
            user_id=1,
            metadata=_dune_metadata(),
        )
        second_metadata = _dune_metadata()
        second_metadata.title = "Dune Messiah"
        second = await create_source_from_metadata(
            context,
            workspace_uuid=WS,
            actor_uuid=ACTOR,
            workspace_id=1,
            user_id=1,
            metadata=second_metadata,
        )

        store = await open_store()
        try:
            first_props = await _props(store, first["node_uuid"])
            second_props = await _props(store, second["node_uuid"])
            assert first_props[SYSTEM_PROPERTY_UUIDS["authors"]] == second_props[SYSTEM_PROPERTY_UUIDS["authors"]]
            # Second source gets a deterministic collision suffix.
            assert second_props[SYSTEM_PROPERTY_UUIDS["citekey"]] == ["herbert1965a"]
            person_rows = await store.query(
                "SELECT id FROM node WHERE active = 1 AND class_ids LIKE ?",
                (f"%{SYSTEM_CLASS_UUIDS['person']}%",),
            )
            assert len(person_rows) == 1
        finally:
            await store.close()

    async def test_provider_failure_creates_nothing(self, harness) -> None:
        """A failed lookup raises before the pipeline runs — no node exists."""
        context, open_store = harness

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"status": "failed"})

        provider = CrossrefProvider(http_client=_mock_client(handler))
        with pytest.raises(MetadataProviderUnavailableError):
            await provider.lookup("10.1000/x")

        store = await open_store()
        try:
            rows = await store.query("SELECT id FROM node WHERE active = 1")
            assert rows == []
        finally:
            await store.close()
