"""Tests for the BibTeX importer on the system source tree."""

from __future__ import annotations

import json

import pytest
import pytest_asyncio

from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.builtin.bibtex.importer import BibTeXImporter
from app.plugins.builtin.bibtex.parser import parse_authors, parse_bibtex
from app.plugins.core.context import PluginContext
from app.plugins.core.ports import ImportContext
from app.plugins.core.registry import PluginRegistry
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit

WS = "ws-1"
ACTOR = "actor-1"

BIB = """
@book{herbert1965,
  author = {Herbert, Frank},
  title = {Dune},
  year = {1965},
  publisher = {Chilton Books},
  isbn = {9780441172719},
  doi = {10.1000/dune},
  url = {https://example.com/dune}
}

@article{tolkien1954,
  author = {Tolkien, J. R. R.},
  title = {The Fellowship of the Ring},
  year = {1954}
}

@phdthesis{smith2020,
  author = {Smith, Jane},
  title = {A Thesis},
  year = {2020}
}

@misc{notes2024,
  title = {Loose Notes},
  year = {2024}
}
"""


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
        plugin_id="notees.bibtex",
        permissions={
            "read_nodes",
            "write_nodes",
            "read_properties",
            "write_properties",
            "settings",
            "import",
        },
        registry=PluginRegistry(),
        port_factories={
            "WorkspaceStore": workspace_store_factory,
            "SettingsRepository": settings_factory,
        },
    )

    importer = BibTeXImporter()

    async def run_import(payload: bytes) -> list[str]:
        result = await importer.import_data(
            payload,
            "application/x-bibtex",
            ImportContext(
                workspace_id=1,
                user_id=1,
                plugin_context=context,
                workspace_uuid=WS,
                actor_uuid=ACTOR,
            ),
        )
        return result.created_node_ids

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

    return settings, run_import, open_store


async def _props(store: WorkspaceStore, node_uuid: str) -> dict[str, list]:
    rows = await store.query(
        "SELECT property_schema_id, idx, value FROM property_value WHERE node_id = ? ORDER BY property_schema_id, idx",
        (node_uuid,),
    )
    result: dict[str, list] = {}
    for row in rows:
        result.setdefault(row["property_schema_id"], []).append(json.loads(row["value"]))
    return result


@pytest.mark.unit
def test_parse_authors() -> None:
    assert parse_authors("Herbert, Frank") == [{"given_name": "Frank", "family_name": "Herbert"}]
    assert parse_authors("Herbert, Frank and Tolkien, J. R. R.") == [
        {"given_name": "Frank", "family_name": "Herbert"},
        {"given_name": "J. R. R.", "family_name": "Tolkien"},
    ]
    assert parse_authors("Frank Herbert") == [{"given_name": "Frank", "family_name": "Herbert"}]
    assert parse_authors("Plato") == [{"given_name": "", "family_name": "Plato"}]
    assert parse_authors("") == []


@pytest.mark.unit
def test_parse_bibtex_entry_accessors() -> None:
    entries = parse_bibtex(BIB)
    assert [e.cite_key for e in entries] == [
        "herbert1965",
        "tolkien1954",
        "smith2020",
        "notes2024",
    ]
    book = entries[0]
    assert book.doi == "10.1000/dune"
    assert book.isbn == "9780441172719"
    assert book.publisher == "Chilton Books"
    assert book.publication_date == "1965"


class TestBibTeXImporterOntoSystemTree:
    async def test_entries_land_on_system_classes(self, harness) -> None:
        _, run_import, open_store = harness
        await run_import(BIB.encode())

        store = await open_store()
        try:
            rows = await store.query("SELECT id, class_ids, content FROM node WHERE active = 1 AND kind = 'page'")
            class_by_citekey = {}
            for row in rows:
                props = await _props(store, row["id"])
                citekey = props.get(SYSTEM_PROPERTY_UUIDS["citekey"], [None])[0]
                if citekey:
                    class_by_citekey[citekey] = json.loads(row["class_ids"])

            assert class_by_citekey["herbert1965"] == [SYSTEM_CLASS_UUIDS["book"]]
            assert class_by_citekey["tolkien1954"] == [SYSTEM_CLASS_UUIDS["paper"]]
            assert class_by_citekey["smith2020"] == [SYSTEM_CLASS_UUIDS["thesis"]]
            assert class_by_citekey["notes2024"] == [SYSTEM_CLASS_UUIDS["document"]]

            # No ad-hoc "Source: BibTeX" class was created.
            class_rows = await store.query("SELECT id FROM class")
            assert class_rows == []
        finally:
            await store.close()

    async def test_book_properties_and_authors(self, harness) -> None:
        _, run_import, open_store = harness
        await run_import(BIB.encode())

        store = await open_store()
        try:
            rows = await store.query("SELECT id, class_ids FROM node WHERE active = 1 AND kind = 'page'")
            book = next(r for r in rows if SYSTEM_CLASS_UUIDS["book"] in json.loads(r["class_ids"]))
            person = next(r for r in rows if SYSTEM_CLASS_UUIDS["person"] in json.loads(r["class_ids"]))
            props = await _props(store, book["id"])
            assert props[SYSTEM_PROPERTY_UUIDS["authors"]] == [person["id"]]
            assert props[SYSTEM_PROPERTY_UUIDS["doi"]] == ["10.1000/dune"]
            assert props[SYSTEM_PROPERTY_UUIDS["publication_date"]] == ["1965"]
            assert props[SYSTEM_PROPERTY_UUIDS["isbn"]] == ["9780441172719"]
            assert props[SYSTEM_PROPERTY_UUIDS["publisher"]] == ["Chilton Books"]
            assert props[SYSTEM_PROPERTY_UUIDS["url"]] == ["https://example.com/dune"]
            assert props[SYSTEM_PROPERTY_UUIDS["citekey"]] == ["herbert1965"]

            person_props = await _props(store, person["id"])
            assert person_props[SYSTEM_PROPERTY_UUIDS["given_name"]] == ["Frank"]
            assert person_props[SYSTEM_PROPERTY_UUIDS["family_name"]] == ["Herbert"]
        finally:
            await store.close()

    async def test_reimport_is_idempotent(self, harness) -> None:
        _, run_import, open_store = harness
        first = await run_import(BIB.encode())
        second = await run_import(BIB.encode())
        assert first == second

        store = await open_store()
        try:
            rows = await store.query("SELECT id FROM node WHERE active = 1")
            # 4 entries + 3 distinct persons (Herbert, Tolkien, Smith).
            assert len(rows) == 7
        finally:
            await store.close()

    async def test_reimport_never_overwrites_existing_citekey(self, harness) -> None:
        _, run_import, open_store = harness
        first = await run_import(BIB.encode())
        book_id = first[0]

        store = await open_store()
        await store.set_property(
            property_value_id="user-edit-1",
            node_id=book_id,
            schema_id=SYSTEM_PROPERTY_UUIDS["citekey"],
            value="my-edited-key",
        )
        await store.close()

        await run_import(BIB.encode())

        store = await open_store()
        try:
            props = await _props(store, book_id)
            assert props[SYSTEM_PROPERTY_UUIDS["citekey"]] == ["my-edited-key"]
        finally:
            await store.close()
