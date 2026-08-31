"""Integration tests for the Zotero sync source on the system source tree."""

from __future__ import annotations

import json

import pytest
import pytest_asyncio

from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.builtin.zotero import sync as sync_module
from app.plugins.builtin.zotero.client import ZoteroItem
from app.plugins.builtin.zotero.sync import ZoteroSyncSource
from app.plugins.core.context import PluginContext
from app.plugins.core.ports import SyncContext
from app.plugins.core.registry import PluginRegistry
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit

WS = "ws-1"
ACTOR = "actor-1"


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
async def harness(monkeypatch: pytest.MonkeyPatch):
    """PluginContext + sync source wired to in-memory stores.

    Returns (context, settings, set_items) where ``set_items`` replaces the
    items the fake Zotero client returns on the next sync.
    """
    relay = SqliteRelayStorage(":memory:")
    settings: dict = {"plugin:notees.zotero:library_id": "123"}

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
        plugin_id="notees.zotero",
        permissions={
            "read_nodes",
            "write_nodes",
            "read_properties",
            "write_properties",
            "settings",
            "background_sync",
            "router",
        },
        registry=PluginRegistry(),
        port_factories={
            "WorkspaceStore": workspace_store_factory,
            "SettingsRepository": settings_factory,
        },
    )

    items: list[ZoteroItem] = []

    class FakeZoteroClient:
        def __init__(self, **kwargs) -> None:
            pass

        async def fetch_items(self, limit: int = 100) -> list[ZoteroItem]:
            return list(items)

    monkeypatch.setattr(sync_module, "ZoteroClient", FakeZoteroClient)

    def set_items(new_items: list[ZoteroItem]) -> None:
        items.clear()
        items.extend(new_items)

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

    source = ZoteroSyncSource()

    async def run_sync() -> sync_module.SyncResult:
        return await source.sync(
            SyncContext(
                workspace_id=1,
                user_id=1,
                plugin_context=context,
                workspace_uuid=WS,
                actor_uuid=ACTOR,
            )
        )

    return context, settings, set_items, open_store, run_sync


def _book_item(**overrides) -> ZoteroItem:
    defaults = {
        "key": "ABC123",
        "title": "Dune",
        "item_type": "book",
        "creators": [{"firstName": "Frank", "lastName": "Herbert", "name": "", "creatorType": "author"}],
        "date": "August 1965",
        "url": "https://example.com/dune",
        "doi": "10.1000/dune",
        "abstract": None,
        "tags": ["sf", "classic"],
        "citekey": "herbert1965",
        "isbn": "9780441172719",
        "publisher": "Chilton Books",
    }
    defaults.update(overrides)
    return ZoteroItem(**defaults)


async def _source_nodes(store: WorkspaceStore) -> list[dict]:
    rows = await store.query("SELECT id, class_ids, content FROM node WHERE active = 1 AND kind = 'page'")
    return [{"id": r["id"], "class_ids": json.loads(r["class_ids"]), "content": r["content"]} for r in rows]


async def _props(store: WorkspaceStore, node_uuid: str) -> dict[str, list]:
    rows = await store.query(
        "SELECT property_schema_id, idx, value FROM property_value WHERE node_id = ? ORDER BY property_schema_id, idx",
        (node_uuid,),
    )
    result: dict[str, list] = {}
    for row in rows:
        result.setdefault(row["property_schema_id"], []).append(json.loads(row["value"]))
    return result


class TestZoteroSyncOntoSystemTree:
    async def test_book_lands_on_system_tree(self, harness) -> None:
        _, _, set_items, open_store, run_sync = harness
        set_items([_book_item()])

        result = await run_sync()
        assert "Synced 1 Zotero items" in result.messages

        store = await open_store()
        try:
            nodes = await _source_nodes(store)
            # One book page + one person agent.
            book = next(n for n in nodes if SYSTEM_CLASS_UUIDS["book"] in n["class_ids"])
            agent = next(n for n in nodes if SYSTEM_CLASS_UUIDS["person"] in n["class_ids"])

            props = await _props(store, book["id"])
            assert props[SYSTEM_PROPERTY_UUIDS["authors"]] == [agent["id"]]
            assert props[SYSTEM_PROPERTY_UUIDS["doi"]] == ["10.1000/dune"]
            assert props[SYSTEM_PROPERTY_UUIDS["publication_date"]] == ["August 1965"]
            assert props[SYSTEM_PROPERTY_UUIDS["isbn"]] == ["9780441172719"]
            assert props[SYSTEM_PROPERTY_UUIDS["publisher"]] == ["Chilton Books"]
            assert props[SYSTEM_PROPERTY_UUIDS["url"]] == ["https://example.com/dune"]
            assert props[SYSTEM_PROPERTY_UUIDS["tags"]] == ["sf", "classic"]
            # Zotero's own citation key is adopted.
            assert props[SYSTEM_PROPERTY_UUIDS["citekey"]] == ["herbert1965"]

            agent_props = await _props(store, agent["id"])
            assert agent_props[SYSTEM_PROPERTY_UUIDS["given_name"]] == ["Frank"]
            assert agent_props[SYSTEM_PROPERTY_UUIDS["family_name"]] == ["Herbert"]

            # No ad-hoc "Source*" class was created.
            class_rows = await store.query("SELECT id, name FROM class")
            assert class_rows == []
        finally:
            await store.close()

    async def test_item_type_mapping(self, harness) -> None:
        _, _, set_items, open_store, run_sync = harness
        set_items(
            [
                _book_item(key="K1", item_type="journalArticle", title="Paper One"),
                _book_item(key="K2", item_type="magazineArticle", title="Article One"),
                _book_item(key="K3", item_type="thesis", title="Thesis One"),
                _book_item(key="K4", item_type="report", title="Report One"),
            ]
        )
        await run_sync()

        store = await open_store()
        try:
            nodes = await _source_nodes(store)
            by_title = {
                n["id"]: n["class_ids"]
                for n in nodes
                for title in ["Paper One", "Article One", "Thesis One", "Report One"]
                if title in n["content"]
            }
            classes = list(by_title.values())
            assert [SYSTEM_CLASS_UUIDS["paper"]] in classes
            assert [SYSTEM_CLASS_UUIDS["article"]] in classes
            assert [SYSTEM_CLASS_UUIDS["thesis"]] in classes
            assert [SYSTEM_CLASS_UUIDS["document"]] in classes
        finally:
            await store.close()

    async def test_two_syncs_are_idempotent(self, harness) -> None:
        _, _, set_items, open_store, run_sync = harness
        set_items([_book_item()])

        first = await run_sync()
        second = await run_sync()
        assert first.created_node_ids == second.created_node_ids

        store = await open_store()
        try:
            nodes = await _source_nodes(store)
            assert len(nodes) == 2  # one book + one person, no duplicates
            book = next(n for n in nodes if SYSTEM_CLASS_UUIDS["book"] in n["class_ids"])
            props = await _props(store, book["id"])
            assert props[SYSTEM_PROPERTY_UUIDS["citekey"]] == ["herbert1965"]
            schema_rows = await store.query("SELECT id, name FROM property_schema WHERE active = 1")
            assert [r["name"] for r in schema_rows] == ["Zotero Key"]
        finally:
            await store.close()

    async def test_resync_never_overwrites_existing_citekey(self, harness) -> None:
        context, _, set_items, open_store, run_sync = harness
        set_items([_book_item()])
        await run_sync()

        store = await open_store()
        book_id = next(n["id"] for n in await _source_nodes(store) if SYSTEM_CLASS_UUIDS["book"] in n["class_ids"])
        await store.close()

        # User edits the citekey; Zotero also changes its citationKey.
        store = await open_store()
        await store.set_property(
            property_value_id="user-edit-1",
            node_id=book_id,
            schema_id=SYSTEM_PROPERTY_UUIDS["citekey"],
            value="my-custom-key",
        )
        await store.close()

        set_items([_book_item(citekey="zotero-renamed-key")])
        await run_sync()

        store = await open_store()
        try:
            props = await _props(store, book_id)
            assert props[SYSTEM_PROPERTY_UUIDS["citekey"]] == ["my-custom-key"]
        finally:
            await store.close()

    async def test_generated_citekeys_collide_deterministically(self, harness) -> None:
        _, _, set_items, open_store, run_sync = harness
        set_items(
            [
                _book_item(key="K1", title="Dune", citekey=None),
                _book_item(key="K2", title="Dune Messiah", citekey=None),
            ]
        )
        await run_sync()

        store = await open_store()
        try:
            keys = []
            for node in await _source_nodes(store):
                if SYSTEM_CLASS_UUIDS["book"] not in node["class_ids"]:
                    continue
                props = await _props(store, node["id"])
                keys.append(props[SYSTEM_PROPERTY_UUIDS["citekey"]][0])
            assert sorted(keys) == ["herbert1965", "herbert1965a"]
        finally:
            await store.close()

    async def test_pattern_setting_applies_to_future_generations(self, harness) -> None:
        _, settings, set_items, open_store, run_sync = harness
        set_items([_book_item(key="K1", title="Dune", citekey=None)])
        await run_sync()

        settings["citekey_pattern"] = "{title_word:upper}-{year}"
        set_items(
            [
                _book_item(key="K1", title="Dune", citekey=None),
                _book_item(key="K2", title="Dune Messiah", citekey=None),
            ]
        )
        await run_sync()

        store = await open_store()
        try:
            keys_by_title = {}
            for node in await _source_nodes(store):
                if SYSTEM_CLASS_UUIDS["book"] not in node["class_ids"]:
                    continue
                props = await _props(store, node["id"])
                title = "Dune Messiah" if "Messiah" in node["content"] else "Dune"
                keys_by_title[title] = props[SYSTEM_PROPERTY_UUIDS["citekey"]][0]
            # The first book keeps its original key; only the new one uses the
            # new pattern.
            assert keys_by_title == {"Dune": "herbert1965", "Dune Messiah": "DUNE-1965"}
        finally:
            await store.close()

    async def test_single_field_creator_becomes_organization(self, harness) -> None:
        _, _, set_items, open_store, run_sync = harness
        set_items(
            [
                _book_item(
                    key="K9",
                    creators=[{"firstName": "", "lastName": "", "name": "Penguin Books", "creatorType": "author"}],
                    citekey=None,
                    date="2001",
                )
            ]
        )
        await run_sync()

        store = await open_store()
        try:
            nodes = await _source_nodes(store)
            org = next(n for n in nodes if SYSTEM_CLASS_UUIDS["organization"] in n["class_ids"])
            book = next(n for n in nodes if SYSTEM_CLASS_UUIDS["book"] in n["class_ids"])
            props = await _props(store, book["id"])
            assert props[SYSTEM_PROPERTY_UUIDS["authors"]] == [org["id"]]
            # family_name unresolved → falls back to the title word.
            assert props[SYSTEM_PROPERTY_UUIDS["citekey"]] == ["dune2001"]
        finally:
            await store.close()

    async def test_items_without_title_or_citekey_are_skipped(self, harness) -> None:
        _, _, set_items, _, run_sync = harness
        set_items([_book_item(title="", citekey=None)])
        result = await run_sync()
        assert "Synced 0 Zotero items" in result.messages
        assert "Skipped 1 items without title or citekey" in result.messages
