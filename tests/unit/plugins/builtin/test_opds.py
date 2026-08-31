"""Tests for the OPDS builtin plugin (Task 16).

Covers the acquisition rule (has_asset semantics), feed XML generation
(well-formedness, entries, identifiers, cover links, no internal paths),
cover resolution (cover property with parent fallback, role=cover secondary),
per-user authentication (HTTP Basic + challenge header), the download
redirect into the existing asset token flow, and the selection mechanism
parity with export profiles — over a real WorkspaceStore.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime
from xml.etree import ElementTree as ET

import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.builtin.export_profiles.dependencies import RequestContext
from app.plugins.builtin.opds import dependencies as opds_dependencies
from app.plugins.builtin.opds import router as opds_router
from app.plugins.builtin.opds.feed import (
    ACQ_MEDIA_TYPE,
    NAV_MEDIA_TYPE,
    build_acquisition_feed,
    build_root_feed,
)
from app.plugins.builtin.opds.selection import (
    CatalogBuilder,
    CatalogEntry,
    acquisition_attachments,
    default_query,
)
from app.plugins.core.context import PluginContext
from app.plugins.core.export import ExportAttachment
from app.plugins.core.registry import PluginRegistry
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit

WS = "ws-1"
ACTOR = "actor-1"
FEED_BASE = "http://test/api/plugins/notees.opds"
FEED_ID = "urn:notees:opds:ws-1"

ATOM = "{http://www.w3.org/2005/Atom}"
DC = "{http://purl.org/dc/terms/}"

BOOK = SYSTEM_CLASS_UUIDS["book"]
SOURCE = SYSTEM_CLASS_UUIDS["source"]
ASSET = SYSTEM_CLASS_UUIDS["asset"]
PERSON = SYSTEM_CLASS_UUIDS["person"]
ATTACHMENTS = SYSTEM_PROPERTY_UUIDS["attachments"]
AUTHORS = SYSTEM_PROPERTY_UUIDS["authors"]
CITEKEY = SYSTEM_PROPERTY_UUIDS["citekey"]
ROLE = SYSTEM_PROPERTY_UUIDS["role"]
COVER = SYSTEM_PROPERTY_UUIDS["cover"]
ISBN = SYSTEM_PROPERTY_UUIDS["isbn"]
DOI = SYSTEM_PROPERTY_UUIDS["doi"]
PUB_DATE = SYSTEM_PROPERTY_UUIDS["publication_date"]


class FixedKeyStorage:
    async def get_or_create_master_key(self, workspace_id: str, secret_key: str) -> bytes:
        return b"0" * 32


def _attachment(
    uuid: str,
    name: str,
    role: str | None = "representation",
    mime: str = "application/epub+zip",
) -> ExportAttachment:
    return ExportAttachment(
        asset_uuid=uuid,
        asset_hash=f"hash-{uuid}",
        mime_type=mime,
        size=10,
        original_name=name,
        role=role,
    )


def _entry(**kwargs) -> CatalogEntry:
    defaults = {
        "uuid": "src-1",
        "title": "Dune",
        "class_names": ["book", "source"],
        "acquisitions": [_attachment("asset-1", "dune.epub")],
    }
    defaults.update(kwargs)
    return CatalogEntry(**defaults)


def _parse(xml: bytes) -> ET.Element:
    return ET.fromstring(xml)  # noqa: S314 - feeds we generated ourselves


# ── Acquisition rule (has_asset semantics) ────────────────────────────────────


def test_acquisition_rule_role_semantics():
    attachments = [
        _attachment("a-rep", "book.epub", role="representation"),
        _attachment("a-none", "book.pdf", role=None, mime="application/pdf"),
        _attachment("a-cover", "cover.png", role="cover", mime="image/png"),
        _attachment("a-supp", "notes.pdf", role="supplement", mime="application/pdf"),
    ]
    selected = acquisition_attachments(attachments)
    assert [a.asset_uuid for a in selected] == ["a-rep", "a-none"]


# ── Feed rendering ────────────────────────────────────────────────────────────


def test_root_feed_well_formed_navigation():
    entries = [
        _entry(uuid="src-1", class_names=["book", "source"]),
        _entry(uuid="src-2", title="Paper A", class_names=["paper", "source"]),
        _entry(uuid="src-3", title="Paper B", class_names=["paper", "source"]),
    ]
    root = _parse(build_root_feed(FEED_BASE, FEED_ID, entries))
    assert root.tag == f"{ATOM}feed"
    nav_entries = root.findall(f"{ATOM}entry")
    titles = [e.findtext(f"{ATOM}title") for e in nav_entries]
    assert titles == ["All publications", "Book", "Paper"]

    all_link = nav_entries[0].find(f"{ATOM}link")
    assert all_link is not None
    assert all_link.get("href") == f"{FEED_BASE}/opds/all"
    assert all_link.get("type") == ACQ_MEDIA_TYPE
    assert nav_entries[0].findtext(f"{ATOM}content") == "3 publications"

    book_link = nav_entries[1].find(f"{ATOM}link")
    assert book_link is not None
    assert book_link.get("href") == f"{FEED_BASE}/opds/class/book"
    assert book_link.get("rel") == "subsection"


def test_acquisition_feed_entry_fields_and_links():
    entry = _entry(
        uuid="11111111-2222-3333-4444-555555555555",
        title="Dune",
        authors=["Frank Herbert", "Brian Herbert"],
        isbn="9780441172719",
        doi="10.1000/xyz",
        citekey="herbert1965",
        publication_date="1965-08-01",
        cover=_attachment("asset-cover", "cover.jpg", role=None, mime="image/jpeg"),
    )
    root = _parse(
        build_acquisition_feed(FEED_BASE, f"{FEED_ID}:all", "All publications", [entry], "/opds/all")
    )
    assert root.tag == f"{ATOM}feed"
    parsed = root.find(f"{ATOM}entry")
    assert parsed is not None
    assert parsed.findtext(f"{ATOM}id") == "urn:uuid:11111111-2222-3333-4444-555555555555"
    assert parsed.findtext(f"{ATOM}title") == "Dune"
    assert parsed.find(f"{ATOM}updated") is not None

    authors = [a.findtext(f"{ATOM}name") for a in parsed.findall(f"{ATOM}author")]
    assert authors == ["Frank Herbert", "Brian Herbert"]
    creators = [c.text for c in parsed.findall(f"{DC}creator")]
    assert creators == ["Frank Herbert", "Brian Herbert"]

    identifiers = [i.text for i in parsed.findall(f"{DC}identifier")]
    assert identifiers == ["isbn:9780441172719", "doi:10.1000/xyz", "citekey:herbert1965"]
    assert parsed.findtext(f"{DC}issued") == "1965-08-01"
    assert parsed.findtext(f"{ATOM}published") == "1965-08-01"

    links = parsed.findall(f"{ATOM}link")
    by_rel = {link.get("rel"): link for link in links}
    acquisition = by_rel["http://opds-spec.org/acquisition"]
    assert acquisition.get("type") == "application/epub+zip"
    assert acquisition.get("href") == f"{FEED_BASE}/opds/download/asset-1"
    assert acquisition.get("title") == "dune.epub"
    cover = by_rel["http://opds-spec.org/image"]
    assert cover.get("href") == f"{FEED_BASE}/opds/download/asset-cover"
    assert cover.get("type") == "image/jpeg"
    assert "http://opds-spec.org/image/thumbnail" in by_rel


def test_feed_never_leaks_internal_paths_or_hashes():
    entry = _entry(cover=_attachment("asset-cover", "c.png", role=None, mime="image/png"))
    xml = build_acquisition_feed(
        FEED_BASE, f"{FEED_ID}:all", "All", [entry], "/opds/all"
    ).decode()
    # Asset hashes and storage paths must not appear; only opaque UUID URLs.
    assert "hash-asset-1" not in xml
    assert "hash-asset-cover" not in xml
    assert "/data/" not in xml
    assert "assets/" not in xml


def test_feed_escapes_special_characters():
    entry = _entry(title='A <B> & "C"', authors=["O'Neil & Sons"])
    root = _parse(build_acquisition_feed(FEED_BASE, f"{FEED_ID}:all", "All", [entry], "/opds/all"))
    parsed = root.find(f"{ATOM}entry")
    assert parsed is not None
    assert parsed.findtext(f"{ATOM}title") == 'A <B> & "C"'


def test_entry_without_cover_has_no_image_links():
    root = _parse(build_acquisition_feed(FEED_BASE, f"{FEED_ID}:all", "All", [_entry()], "/opds/all"))
    parsed = root.find(f"{ATOM}entry")
    assert parsed is not None
    rels = {link.get("rel") for link in parsed.findall(f"{ATOM}link")}
    assert "http://opds-spec.org/image" not in rels


# ── CatalogBuilder over a real WorkspaceStore ─────────────────────────────────


@pytest_asyncio.fixture
async def relay():
    return SqliteRelayStorage(":memory:")


def _make_store(relay) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=WS,
        actor_id=ACTOR,
        relay_storage=relay,
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )


async def _seed_system_schema(store: WorkspaceStore) -> None:
    await store.create_class(SOURCE, "source")
    await store.create_class(BOOK, "book", extends_class_ids=[SOURCE])
    await store.create_class(ASSET, "asset")
    await store.create_class(PERSON, "person")
    await store.create_property_schema(ATTACHMENTS, "attachments", "node", multi=True)
    await store.create_property_schema(AUTHORS, "authors", "node", multi=True)
    await store.create_property_schema(CITEKEY, "citekey", "text")
    await store.create_property_schema(ROLE, "role", "selection")
    await store.create_property_schema(COVER, "cover", "node")
    await store.create_property_schema(ISBN, "isbn", "text")
    await store.create_property_schema(DOI, "doi", "text")
    await store.create_property_schema(PUB_DATE, "publication_date", "date")
    await store.sync()


async def _set(store: WorkspaceStore, node_id: str, schema: str, value, index: int = 0) -> None:
    await store.set_property(
        property_value_id=uuidv7(), node_id=node_id, schema_id=schema, value=value, index=index
    )


async def _create_asset_node(store: WorkspaceStore, name: str, role: str | None) -> str:
    """Create a minimal asset node (node + node_asset row) via the asset service."""
    from app.features.assets.service import AssetService

    service = AssetService(WS, ACTOR, store)
    result = await service.upload_asset(
        file_bytes=b"bytes-of-" + name.encode(),
        filename=name,
        content_type="application/epub+zip",
    )
    if role is not None:
        await _set(store, result["uuid"], ROLE, role)
    return result["uuid"]


async def _create_book(store: WorkspaceStore, title: str, **kwargs) -> str:
    node_uuid = uuidv7()
    await store.create_node(
        node_uuid,
        "page",
        initial_content=[{"type": "paragraph", "children": [{"text": title}]}],
        class_ids=[BOOK],
        **kwargs,
    )
    return node_uuid


@pytest_asyncio.fixture
async def store(relay):
    store = _make_store(relay)
    await _seed_system_schema(store)
    yield store
    await store.close()


async def test_catalog_excludes_attachment_less_sources(store):
    attached = await _create_book(store, "Dune")
    asset_uuid = await _create_asset_node(store, "dune.epub", "representation")
    await _set(store, attached, ATTACHMENTS, asset_uuid)
    await _create_book(store, "No Files")
    await store.sync()

    entries = await CatalogBuilder(store).entries_for_query(default_query())
    assert [e.title for e in entries] == ["Dune"]
    assert [a.asset_uuid for a in entries[0].acquisitions] == [asset_uuid]


async def test_catalog_resolves_metadata_and_authors(store):
    book = await _create_book(store, "Dune")
    author = uuidv7()
    await store.create_node(
        author,
        "page",
        initial_content=[{"type": "paragraph", "children": [{"text": "Frank Herbert"}]}],
        class_ids=[PERSON],
    )
    await _set(store, book, AUTHORS, author)
    await _set(store, book, ISBN, "9780441172719")
    await _set(store, book, CITEKEY, "herbert1965")
    await _set(store, book, PUB_DATE, "1965-08-01")
    asset_uuid = await _create_asset_node(store, "dune.epub", "representation")
    await _set(store, book, ATTACHMENTS, asset_uuid)
    await store.sync()

    entries = await CatalogBuilder(store).entries_for_query(default_query())
    assert len(entries) == 1
    entry = entries[0]
    assert entry.authors == ["Frank Herbert"]
    assert entry.isbn == "9780441172719"
    assert entry.citekey == "herbert1965"
    assert entry.publication_date == "1965-08-01"
    assert entry.primary_class == "book"


async def test_cover_property_with_parent_fallback(store):
    work = await _create_book(store, "Dune (Work)")
    edition = await _create_book(store, "Dune (1965)", parent_id=work)
    cover_asset = await _create_asset_node(store, "cover.png", None)
    await _set(store, work, COVER, cover_asset)
    epub_asset = await _create_asset_node(store, "dune.epub", "representation")
    await _set(store, edition, ATTACHMENTS, epub_asset)
    await store.sync()

    entries = await CatalogBuilder(store).entries_for_query(default_query())
    by_title = {e.title: e for e in entries}
    # The work has no downloadable asset → absent; the edition inherits its cover.
    assert set(by_title) == {"Dune (1965)"}
    assert by_title["Dune (1965)"].cover is not None
    assert by_title["Dune (1965)"].cover.asset_uuid == cover_asset


async def test_cover_property_wins_over_role_cover_attachment(store):
    book = await _create_book(store, "Dune")
    cover_asset = await _create_asset_node(store, "canonical.png", None)
    role_cover = await _create_asset_node(store, "secondary.png", "cover")
    epub_asset = await _create_asset_node(store, "dune.epub", "representation")
    await _set(store, book, COVER, cover_asset)
    await _set(store, book, ATTACHMENTS, role_cover)
    await _set(store, book, ATTACHMENTS, epub_asset, index=1)
    await store.sync()

    entries = await CatalogBuilder(store).entries_for_query(default_query())
    assert len(entries) == 1
    assert entries[0].cover is not None
    assert entries[0].cover.asset_uuid == cover_asset
    # The role=cover asset is not an acquisition candidate.
    assert [a.asset_uuid for a in entries[0].acquisitions] == [epub_asset]


async def test_role_cover_attachment_is_secondary_cover(store):
    book = await _create_book(store, "Dune")
    role_cover = await _create_asset_node(store, "secondary.png", "cover")
    epub_asset = await _create_asset_node(store, "dune.epub", "representation")
    await _set(store, book, ATTACHMENTS, role_cover)
    await _set(store, book, ATTACHMENTS, epub_asset, index=1)
    await store.sync()

    entries = await CatalogBuilder(store).entries_for_query(default_query())
    assert len(entries) == 1
    assert entries[0].cover is not None
    assert entries[0].cover.asset_uuid == role_cover


# ── Router-level tests (feed endpoints, auth, download redirect) ──────────────


class FakeSettingsRepo:
    def __init__(self):
        self.data: dict[int, dict[str, object]] = {}

    async def get_workspace_settings(self, workspace_id: int):
        return dict(self.data.get(workspace_id, {}))

    async def set_workspace_setting(self, workspace_id, key, value, now, user_id):
        self.data.setdefault(workspace_id, {})[key] = value


def _fake_user() -> dict:
    return {
        "id": "1",
        "uuid": ACTOR,
        "email": "reader@example.com",
        "name": None,
        "surnames": None,
        "profile_pic": None,
        "role": "user",
        "created_at": datetime.now(UTC),
        "is_active": True,
    }


def _fake_ctx() -> RequestContext:
    from app.models import User

    return RequestContext(
        user=User(**_fake_user()),
        workspace_id=1,
        workspace_uuid=WS,
        user_uuid=ACTOR,
    )


@pytest_asyncio.fixture
async def app_client(store):
    """FastAPI app with the OPDS router and a wired plugin runtime."""
    settings_repo = FakeSettingsRepo()

    async def settings_factory(workspace_id, user_id):
        return settings_repo

    async def store_factory(workspace_uuid, actor_uuid):
        return store

    context = PluginContext(
        plugin_id="notees.opds",
        permissions={"read_nodes", "read_properties", "read_assets", "settings", "router"},
        registry=PluginRegistry(),
        port_factories={
            "SettingsRepository": settings_factory,
            "WorkspaceStore": store_factory,
        },
    )
    previous = opds_router.runtime.context
    opds_router.runtime.context = context

    app = FastAPI()
    app.include_router(opds_router.router, prefix="/api/plugins/notees.opds")
    app.dependency_overrides[opds_router.get_opds_request_context] = _fake_ctx
    app.dependency_overrides[opds_router.get_request_context] = _fake_ctx

    # The settings endpoints guard with scope dependencies that resolve the
    # user via the core auth dependency; stub it for the test app.
    from app.dependencies import get_current_user
    from app.models import User

    app.dependency_overrides[get_current_user] = lambda: User(**_fake_user())

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, settings_repo
    opds_router.runtime.context = previous


async def _seed_dune(store: WorkspaceStore) -> tuple[str, str]:
    book = await _create_book(store, "Dune")
    asset_uuid = await _create_asset_node(store, "dune.epub", "representation")
    await _set(store, book, ATTACHMENTS, asset_uuid)
    await store.sync()
    return book, asset_uuid


async def test_router_root_and_acquisition_feeds(store, app_client):
    client, _ = app_client
    await _seed_dune(store)
    await _create_book(store, "Attachment-less")
    await store.sync()

    root_response = await client.get("/api/plugins/notees.opds/opds")
    assert root_response.status_code == 200
    assert root_response.headers["content-type"].startswith(NAV_MEDIA_TYPE)
    root = _parse(root_response.content)
    titles = [e.findtext(f"{ATOM}title") for e in root.findall(f"{ATOM}entry")]
    assert titles == ["All publications", "Book"]

    feed_response = await client.get("/api/plugins/notees.opds/opds/all")
    assert feed_response.status_code == 200
    assert feed_response.headers["content-type"].startswith(ACQ_MEDIA_TYPE)
    feed = _parse(feed_response.content)
    entries = feed.findall(f"{ATOM}entry")
    # The attachment-less book is absent and causes no feed error.
    assert [e.findtext(f"{ATOM}title") for e in entries] == ["Dune"]
    body = feed_response.text
    assert "/api/plugins/notees.opds/opds/download/" in body
    assert "hash-" not in body

    class_response = await client.get("/api/plugins/notees.opds/opds/class/book")
    assert class_response.status_code == 200
    class_feed = _parse(class_response.content)
    assert len(class_feed.findall(f"{ATOM}entry")) == 1

    empty_response = await client.get("/api/plugins/notees.opds/opds/class/paper")
    assert empty_response.status_code == 200
    assert _parse(empty_response.content).findall(f"{ATOM}entry") == []


async def test_router_download_redirects_into_asset_token_flow(store, app_client):
    client, _ = app_client
    _, asset_uuid = await _seed_dune(store)

    response = await client.get(
        f"/api/plugins/notees.opds/opds/download/{asset_uuid}",
        follow_redirects=False,
    )
    assert response.status_code == 307
    location = response.headers["location"]
    assert location.startswith(f"http://test/api/assets/{asset_uuid}?asset_token=")

    from app.features.assets.dependencies import _decode_asset_token

    token = location.split("asset_token=", 1)[1]
    payload = _decode_asset_token(token)
    assert payload is not None
    assert payload["asset_uuid"] == asset_uuid
    assert payload["type"] == "asset_access"

    missing = await client.get(
        f"/api/plugins/notees.opds/opds/download/{uuidv7()}",
        follow_redirects=False,
    )
    assert missing.status_code == 404


async def test_router_info_and_settings(store, app_client):
    client, settings_repo = app_client
    await _seed_dune(store)

    info = await client.get("/api/plugins/notees.opds/info")
    assert info.status_code == 200
    data = info.json()
    assert data["feed_url"] == "http://test/api/plugins/notees.opds/opds"
    assert data["selection"] == {"kind": "all_sources"}
    assert data["publication_count"] == 1
    assert data["classes"] == [{"name": "book", "count": 1}]

    put = await client.put(
        "/api/plugins/notees.opds/settings", json={"saved_query_id": "query-1"}
    )
    assert put.status_code == 200
    assert settings_repo.data[1]["plugin:notees.opds:catalog"] == {"saved_query_id": "query-1"}

    get = await client.get("/api/plugins/notees.opds/settings")
    assert get.json() == {"saved_query_id": "query-1"}

    # A saved-query selection now drives the catalog (unknown → 422 here,
    # proving the export-profiles resolution path is the one in use).
    feed = await client.get("/api/plugins/notees.opds/opds/all")
    assert feed.status_code == 422


# ── Basic auth dependency ─────────────────────────────────────────────────────


def _basic_request(email: str, password: str) -> Request:
    token = base64.b64encode(f"{email}:{password}".encode()).decode()
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [(b"authorization", f"Basic {token}".encode())],
            "query_string": b"",
        }
    )


def _plain_request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [],
            "query_string": b"",
        }
    )


async def test_basic_auth_success_resolves_context(monkeypatch):
    async def fake_authenticate(email, password):
        assert (email, password) == ("reader@example.com", "s3cret")
        return {**_fake_user(), "hashed_password": "hash"}

    monkeypatch.setattr(opds_dependencies, "authenticate_user", fake_authenticate)

    class _Pool:
        pass

    async def fake_pool():
        return _Pool()

    async def fake_workspace_context(pool, user_id):
        assert user_id == 1
        return 7, None

    async def fake_workspace_uuid(workspace_id):
        assert workspace_id == 7
        return WS

    monkeypatch.setattr(opds_dependencies, "get_pool", fake_pool)
    monkeypatch.setattr(opds_dependencies, "_get_workspace_context_cached", fake_workspace_context)
    monkeypatch.setattr(opds_dependencies, "get_workspace_uuid", fake_workspace_uuid)

    agen = opds_dependencies.get_opds_request_context(
        _basic_request("reader@example.com", "s3cret"), credentials=None
    )
    ctx = await agen.__anext__()
    assert ctx.workspace_id == 7
    assert ctx.workspace_uuid == WS
    assert ctx.user.email == "reader@example.com"
    await agen.aclose()


async def test_basic_auth_invalid_credentials_challenge(monkeypatch):
    async def fake_authenticate(email, password):
        return None

    monkeypatch.setattr(opds_dependencies, "authenticate_user", fake_authenticate)
    with pytest.raises(HTTPException) as excinfo:
        await opds_dependencies.get_opds_request_context(
            _basic_request("reader@example.com", "wrong"), credentials=None
        ).__anext__()
    assert excinfo.value.status_code == 401
    assert excinfo.value.headers == {"WWW-Authenticate": opds_dependencies.BASIC_CHALLENGE}


async def test_no_credentials_challenge(monkeypatch):
    async def fake_resolve(request, credentials, api_key):
        return None

    monkeypatch.setattr(opds_dependencies, "_resolve_user_from_auth", fake_resolve)
    with pytest.raises(HTTPException) as excinfo:
        await opds_dependencies.get_opds_request_context(_plain_request(), credentials=None).__anext__()
    assert excinfo.value.status_code == 401
    assert excinfo.value.headers == {"WWW-Authenticate": opds_dependencies.BASIC_CHALLENGE}


async def test_malformed_basic_header_challenge():
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [(b"authorization", b"Basic !!!not-base64!!!")],
            "query_string": b"",
        }
    )
    with pytest.raises(HTTPException) as excinfo:
        await opds_dependencies.get_opds_request_context(request, credentials=None).__anext__()
    assert excinfo.value.status_code == 401
