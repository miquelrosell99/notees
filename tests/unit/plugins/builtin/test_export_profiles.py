"""Tests for the Export Profiles builtin plugin (Task 15).

Covers the layered engine (manifest → validation → reconciler →
materializer), the bibliographic provider, filename templates, and the
continuous-reconciliation service (post-commit hook, debounce, startup pass,
path containment) using in-memory fakes plus a real WorkspaceStore for the
acceptance flow (upload → file appears; citekey edit → file moves; detach →
file deleted).
"""

from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path

import pytest
import pytest_asyncio

from app.core.clock import Hlc
from app.core.derived import op_listeners
from app.core.operation import Operation, OperationEnvelope
from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.builtin.export_profiles.continuous import ExportContinuousService
from app.plugins.builtin.export_profiles.engine.materializer import (
    CopyMaterializer,
    MaterializerError,
)
from app.plugins.builtin.export_profiles.engine.reconciler import plan_reconciliation
from app.plugins.builtin.export_profiles.engine.runner import (
    ProviderNotFoundError,
    export_profile_zip,
    reconcile_profile,
)
from app.plugins.builtin.export_profiles.engine.validation import (
    PathValidationError,
    sanitize_relative_path,
    validate_relative_path,
)
from app.plugins.builtin.export_profiles.paths import profile_destination_root
from app.plugins.builtin.export_profiles.profiles import (
    ProfileValidationError,
    validate_profile,
)
from app.plugins.builtin.export_profiles.providers import BibliographicProvider
from app.plugins.builtin.export_profiles.services import WorkspaceExportServices
from app.plugins.builtin.export_profiles.templates import (
    render_filename_template,
    resolve_filename_collisions,
)
from app.plugins.core.context import PluginContext
from app.plugins.core.export import (
    ExportAttachment,
    ExportFile,
    ExportManifest,
    ExportNodeContext,
)
from app.plugins.core.registry import PluginRegistry
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit

WS = "ws-1"
ACTOR = "actor-1"

BOOK = SYSTEM_CLASS_UUIDS["book"]
COLLECTION = SYSTEM_CLASS_UUIDS["collection"]
ATTACHMENTS = SYSTEM_PROPERTY_UUIDS["attachments"]
CITEKEY = SYSTEM_PROPERTY_UUIDS["citekey"]
ROLE = SYSTEM_PROPERTY_UUIDS["role"]
PUB_DATE = SYSTEM_PROPERTY_UUIDS["publication_date"]


class FixedKeyStorage:
    async def get_or_create_master_key(self, workspace_id: str, secret_key: str) -> bytes:
        return b"0" * 32


def _class_query_ast(class_uuid: str) -> dict:
    return {
        "type": "query",
        "version": "1.0",
        "scope": {"type": "scope", "scope_type": "entire_workspace"},
        "root_group": {
            "type": "group",
            "logic": "AND",
            "children": [
                {"type": "condition", "condition_type": "class", "class_uuid": class_uuid}
            ],
        },
    }


def _profile(
    tmp_path: Path,
    *,
    profile_id: str = "profile-1",
    name: str = "Books",
    template: str = "/{class}/{citekey}.{ext}",
    roles: list[str] | None = None,
    query: dict | None = None,
) -> dict:
    provider_config: dict = {"filename_template": template}
    if roles is not None:
        provider_config["asset_filter"] = {"roles": roles}
    from app.plugins.builtin.export_profiles.profiles import validate_profile as _v

    return _v(
        {
            "id": profile_id,
            "name": name,
            "provider": "bibliographic",
            "query": query or {"ast": _class_query_ast(BOOK)},
            "provider_config": provider_config,
        }
    )


# ── Filename templates ──────────────────────────────────────────────────────


def test_template_resolves_tokens_and_modifiers():
    rendered = render_filename_template(
        "/{class}/{Author:lower}-{year}",
        {"class": "Book", "author": "Herbert", "year": "1965"},
        title="Dune",
        fallback_uuid="uuid-1",
    )
    assert rendered == "/Book/herbert-1965"


def test_template_missing_token_falls_back_to_title_then_uuid():
    assert (
        render_filename_template("{citekey}", {}, title="Dune", fallback_uuid="u").strip()
        == "Dune"
    )
    assert (
        render_filename_template("{citekey}", {}, title="", fallback_uuid="uuid-9")
        == "uuid-9"
    )
    # Unknown token names also fall back.
    assert (
        render_filename_template("{nonexistent}", {}, title="Dune", fallback_uuid="u")
        == "Dune"
    )


def test_template_ext_alias():
    rendered = render_filename_template(
        "{citekey}.{ext}",
        {"citekey": "herbert1965", "extension": "epub"},
        title="Dune",
        fallback_uuid="u",
    )
    assert rendered == "herbert1965.epub"


def test_filename_collisions_are_deterministic():
    first = resolve_filename_collisions(
        [("b-asset", "a/book.epub"), ("a-asset", "a/book.epub"), ("c-asset", "a/other.epub")]
    )
    second = resolve_filename_collisions(
        [("a-asset", "a/book.epub"), ("c-asset", "a/other.epub"), ("b-asset", "a/book.epub")]
    )
    assert first == second
    assert sorted(first.values()) == ["a/book-2.epub", "a/book.epub", "a/other.epub"]


# ── Path validation / containment ───────────────────────────────────────────


def test_validation_rejects_traversal_and_absolute_paths():
    for bad in ("../../etc/x", "/etc/passwd", "C:/Windows/x", "a/../../b", "ok/\0/x"):
        with pytest.raises(PathValidationError):
            validate_relative_path(bad)


def test_validation_accepts_and_sanitizes_normal_paths():
    assert sanitize_relative_path("book/herbert1965.epub") == "book/herbert1965.epub"
    # Hostile characters are sanitized, not rejected.
    assert sanitize_relative_path('a/b<c>d:e"f.epub') == "a/b-c-d-e-f.epub"
    # ".." produced by token output is rejected at the engine layer too.
    with pytest.raises(PathValidationError):
        sanitize_relative_path("a/../b.epub")


def test_profile_validation_rejects_malicious_template_and_destination():
    with pytest.raises(ProfileValidationError):
        validate_profile(
            {
                "id": "p",
                "name": "x",
                "provider": "bibliographic",
                "query": {"ast": {}},
                "provider_config": {"filename_template": "../../etc/x"},
            }
        )
    with pytest.raises(ProfileValidationError):
        validate_profile(
            {
                "id": "p",
                "name": "x",
                "provider": "bibliographic",
                "query": {"ast": {}},
                "destination": "../escape",
            }
        )


def test_profile_validation_requires_exactly_one_query_form():
    with pytest.raises(ProfileValidationError):
        validate_profile({"id": "p", "name": "x", "provider": "b", "query": {}})


def test_profile_root_containment(tmp_path: Path, monkeypatch):
    from app.config import settings as app_settings

    monkeypatch.setattr(app_settings, "database_dir", tmp_path)
    root = profile_destination_root(None, "user-1", "books", "sub/dir")
    assert root == (tmp_path / "users" / "user-1" / "exports" / "books" / "sub" / "dir").resolve()
    with pytest.raises(ValueError, match="escapes"):
        profile_destination_root("/data", "user-1", "books", "../../outside")


# ── Reconciler ──────────────────────────────────────────────────────────────


def test_reconciler_plans_copies_deletes_and_conflicts(tmp_path: Path):
    desired = {
        "keep.epub": ("asset-1", "hash-1", 10),
        "new.epub": ("asset-2", "hash-2", 20),
        "conflict.epub": ("asset-3", "hash-3", 30),
    }
    (tmp_path / "keep.epub").write_bytes(b"0123456789")
    (tmp_path / "conflict.epub").write_bytes(b"foreign")  # not managed
    managed = {
        "keep.epub": {"asset_uuid": "asset-1", "hash": "hash-1", "size": 10},
        "stale.epub": {"asset_uuid": "asset-9", "hash": "hash-9", "size": 1},
    }
    (tmp_path / "stale.epub").write_bytes(b"x")

    plan = plan_reconciliation(desired, managed, tmp_path)
    assert [c.relative_path for c in plan.copies] == ["new.epub"]
    assert plan.deletes == ["stale.epub"]
    assert [c.relative_path for c in plan.conflicts] == ["conflict.epub"]
    assert plan.unchanged == 1


def test_reconciler_detects_drift_via_size(tmp_path: Path):
    (tmp_path / "a.epub").write_bytes(b"tampered-content")
    desired = {"a.epub": ("asset-1", "hash-1", 4)}
    managed = {"a.epub": {"asset_uuid": "asset-1", "hash": "hash-1", "size": 4}}
    plan = plan_reconciliation(desired, managed, tmp_path)
    assert [c.relative_path for c in plan.copies] == ["a.epub"]
    assert plan.unchanged == 0


def test_reconciler_never_deletes_foreign_files(tmp_path: Path):
    (tmp_path / "foreign.epub").write_bytes(b"foreign")
    plan = plan_reconciliation({}, {}, tmp_path)
    assert plan.deletes == []
    assert (tmp_path / "foreign.epub").exists()


# ── Materializer ────────────────────────────────────────────────────────────


def test_materializer_copy_remove_prune_and_containment(tmp_path: Path):
    materializer = CopyMaterializer(tmp_path / "root")
    size = materializer.copy(BytesIO(b"hello world"), "sub/dir/file.bin")
    assert size == 11
    assert (tmp_path / "root" / "sub" / "dir" / "file.bin").read_bytes() == b"hello world"

    with pytest.raises(MaterializerError):
        materializer.copy(BytesIO(b"x"), "../escape.bin")

    assert materializer.remove("sub/dir/file.bin") is True
    assert materializer.remove("sub/dir/file.bin") is False
    materializer.prune_empty_dirs()
    assert not (tmp_path / "root" / "sub").exists()
    assert (tmp_path / "root").exists()


# ── Bibliographic provider ──────────────────────────────────────────────────


def _node(
    uuid: str,
    title: str,
    *,
    class_names: list[str] | None = None,
    properties: dict | None = None,
    attachments: list[ExportAttachment] | None = None,
) -> ExportNodeContext:
    return ExportNodeContext(
        uuid=uuid,
        title=title,
        class_names=class_names or ["book", "source"],
        properties=properties or {},
        attachments=attachments or [],
    )


def _attachment(uuid: str, name: str, role: str | None = "representation", mime: str = "application/epub+zip"):
    return ExportAttachment(
        asset_uuid=uuid,
        asset_hash=f"hash-{uuid}",
        mime_type=mime,
        size=10,
        original_name=name,
        role=role,
    )


class _NoopServices:
    async def select_node_ids(self, query): return []
    async def build_node_contexts(self, ids): return []
    async def open_asset_stream(self, asset_uuid): return None
    async def get_asset_metadata(self, asset_uuid): return None
    async def resolve_class_names(self, node_uuid): return []


def test_bibliographic_provider_manifest_and_skip_report():
    provider = BibliographicProvider()
    nodes = [
        _node(
            "src-1",
            "Dune",
            properties={"citekey": "herbert1965", "publication_date": "1965-08-01"},
            attachments=[
                _attachment("asset-1", "dune.epub"),
                _attachment("asset-2", "cover.png", role="cover", mime="image/png"),
            ],
        ),
        _node("src-2", "Attachment-less", attachments=[]),
    ]
    manifest = provider.generate_manifest(
        {"filename_template": "/{class}/{citekey}.{ext}"}, nodes, _NoopServices()
    )
    # Only the representation attachment is exported (default role filter).
    assert [(f.asset_uuid, f.relative_path) for f in manifest.files] == [
        ("asset-1", "/book/herbert1965.epub")
    ]
    assert [s.node_uuid for s in manifest.skipped] == ["src-2"]


def test_bibliographic_provider_tokens_and_fallbacks():
    provider = BibliographicProvider()
    nodes = [
        _node(
            "src-1",
            "The Dune Encyclopedia",
            properties={
                "authors": ["Frank Herbert"],
                "year": "ignored",  # {year} comes from publication_date
                "publication_date": "August 1965",
                "series": "Dune Saga",
            },
            attachments=[_attachment("asset-1", "dune.epub")],
        ),
        _node("src-2", "", attachments=[_attachment("asset-2", "x.epub")]),
    ]
    manifest = provider.generate_manifest(
        {"filename_template": "{author}-{year}-{series}/{title}.{extension}"},
        nodes,
        _NoopServices(),
    )
    by_asset = {f.asset_uuid: f.relative_path for f in manifest.files}
    assert by_asset["asset-1"] == "Frank Herbert-1965-Dune Saga/The Dune Encyclopedia.epub"
    # Missing title and tokens → per-token uuid fallback.
    assert by_asset["asset-2"] == "src-2-src-2-src-2/src-2.epub"


def test_bibliographic_provider_multiple_attachments_and_collisions():
    provider = BibliographicProvider()
    nodes = [
        _node(
            "src-1",
            "Dune",
            properties={"citekey": "herbert1965"},
            attachments=[
                _attachment("asset-b", "dune.epub"),
                _attachment("asset-a", "dune.pdf", mime="application/pdf"),
            ],
        ),
        _node(
            "src-2",
            "Dune Messiah",
            properties={"citekey": "herbert1965"},  # colliding citekey
            attachments=[_attachment("asset-c", "messiah.epub")],
        ),
    ]
    manifest = provider.generate_manifest(
        {"filename_template": "{citekey}.{ext}"}, nodes, _NoopServices()
    )
    paths = {f.asset_uuid: f.relative_path for f in manifest.files}
    assert paths["asset-a"] == "herbert1965.pdf"
    assert paths["asset-b"] == "herbert1965.epub"
    # Same stem+ext collision resolved with a deterministic suffix.
    assert paths["asset-c"] == "herbert1965-2.epub"


def test_bibliographic_provider_mime_filter():
    provider = BibliographicProvider()
    nodes = [
        _node(
            "src-1",
            "Dune",
            properties={"citekey": "k"},
            attachments=[
                _attachment("asset-1", "dune.epub"),
                _attachment("asset-2", "dune.pdf", mime="application/pdf"),
            ],
        )
    ]
    manifest = provider.generate_manifest(
        {
            "filename_template": "{citekey}.{ext}",
            "asset_filter": {"roles": None, "mime_types": ["application/pdf"]},
        },
        nodes,
        _NoopServices(),
    )
    assert [f.asset_uuid for f in manifest.files] == ["asset-2"]


# ── Engine runner (fake services) ───────────────────────────────────────────


class FakeServices:
    """In-memory ExportServices for engine-layer tests."""

    def __init__(self, nodes: list[ExportNodeContext], blobs: dict[str, bytes]):
        self._nodes = nodes
        self._blobs = blobs

    async def select_node_ids(self, query):
        return [n.uuid for n in self._nodes]

    async def build_node_contexts(self, ids):
        order = {n.uuid: n for n in self._nodes}
        return [order[i] for i in ids if i in order]

    async def open_asset_stream(self, asset_uuid):
        data = self._blobs.get(asset_uuid)
        return BytesIO(data) if data is not None else None

    async def get_asset_metadata(self, asset_uuid):
        for node in self._nodes:
            for attachment in node.attachments:
                if attachment.asset_uuid == asset_uuid:
                    return attachment
        return None

    async def resolve_class_names(self, node_uuid):
        return []


def _engine_harness(tmp_path: Path, template: str = "/{class}/{citekey}.{ext}"):
    nodes = [
        _node(
            "src-1",
            "Dune",
            properties={"citekey": "herbert1965"},
            attachments=[_attachment("asset-1", "dune.epub")],
        )
    ]
    services = FakeServices(nodes, {"asset-1": b"epub-bytes"})
    provider = BibliographicProvider()
    profile = _profile(tmp_path, template=template)
    lookup = lambda provider_id: provider if provider_id == "bibliographic" else None  # noqa: E731
    return profile, services, lookup


async def test_engine_reconcile_create_then_byte_identical(tmp_path: Path):
    profile, services, lookup = _engine_harness(tmp_path)
    root = tmp_path / "out"

    report1, managed = await reconcile_profile(profile, root, {}, services, lookup)
    assert report1.created == ["book/herbert1965.epub"]
    tree1 = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    bytes1 = (root / "book" / "herbert1965.epub").read_bytes()

    report2, managed2 = await reconcile_profile(profile, root, managed, services, lookup)
    tree2 = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    bytes2 = (root / "book" / "herbert1965.epub").read_bytes()
    assert tree1 == tree2 and bytes1 == bytes2
    assert report2.unchanged == 1 and not report2.created and not report2.deleted
    assert managed2 == managed


async def test_engine_reconcile_move_and_delete(tmp_path: Path):
    profile, services, lookup = _engine_harness(tmp_path)
    root = tmp_path / "out"
    _, managed = await reconcile_profile(profile, root, {}, services, lookup)

    # Citekey change → the file moves to the new templated path.
    services._nodes[0].properties["citekey"] = "herbert1969"
    report, managed = await reconcile_profile(profile, root, managed, services, lookup)
    assert report.created == ["book/herbert1969.epub"]
    assert report.deleted == ["book/herbert1965.epub"]
    assert not (root / "book" / "herbert1965.epub").exists()
    assert (root / "book" / "herbert1969.epub").exists()

    # Attachment removed → source skipped, managed file deleted.
    services._nodes[0].attachments = []
    report, managed = await reconcile_profile(profile, root, managed, services, lookup)
    assert report.deleted == ["book/herbert1969.epub"]
    assert [s["node_uuid"] for s in report.skipped] == ["src-1"]
    assert managed == {}


async def test_engine_rejects_invalid_provider_paths(tmp_path: Path):
    class EvilProvider:
        id = "evil"

        def generate_manifest(self, config, nodes, services):
            return ExportManifest(files=[ExportFile("asset-1", "../../etc/x")])

    nodes = [_node("src-1", "Dune", attachments=[_attachment("asset-1", "dune.epub")])]
    services = FakeServices(nodes, {"asset-1": b"bytes"})
    profile = _profile(tmp_path)
    report, managed = await reconcile_profile(
        profile, tmp_path / "out", {}, services, lambda _: EvilProvider()
    )
    assert len(report.invalid) == 1
    assert managed == {}
    assert not (tmp_path / "etc").exists()


async def test_engine_unknown_provider_raises(tmp_path: Path):
    profile, services, _ = _engine_harness(tmp_path)
    with pytest.raises(ProviderNotFoundError):
        await reconcile_profile(profile, tmp_path / "out", {}, services, lambda _: None)


async def test_engine_zip_is_reproducible(tmp_path: Path):
    profile, services, lookup = _engine_harness(tmp_path)
    zip1, report1 = await export_profile_zip(profile, services, lookup)
    zip2, _ = await export_profile_zip(profile, services, lookup)
    assert zip1 == zip2
    assert report1.created == ["book/herbert1965.epub"]


# ── WorkspaceStore op-listener hook ─────────────────────────────────────────


@pytest_asyncio.fixture
async def relay():
    return SqliteRelayStorage(":memory:")


def _make_store(relay, workspace=WS, actor=ACTOR, db_path=":memory:"):
    return WorkspaceStore(
        workspace_id=workspace,
        actor_id=actor,
        relay_storage=relay,
        db_path=db_path,
        key_storage=FixedKeyStorage(),
    )


def _op(op_type: str, workspace: str = WS, actor: str = ACTOR) -> Operation:
    return Operation(
        envelope=OperationEnvelope(
            id=uuidv7(),
            workspace_id=workspace,
            actor_id=actor,
            hlc=Hlc(physical=1, logical=0),
            affected_node_ids=[],
            op_type=op_type,
        ),
        payload={},
    )


async def test_workspace_store_notifies_op_listeners_on_apply_and_sync(relay):
    seen: list[str] = []
    listener = lambda op: seen.append(op.envelope.op_type)  # noqa: E731
    op_listeners.register(listener)
    try:
        store_a = _make_store(relay)
        await store_a.create_node("node-1", "page")
        assert "node.create" in seen

        # Remote ops replayed via sync() also notify listeners.
        store_b = _make_store(relay, workspace="ws-2")
        await store_b.create_node("node-2", "page")
        await store_b.close()

        store_c = _make_store(relay, workspace="ws-2")
        await store_c.sync()
        await store_c.close()
        # store_a.apply + store_b.apply + store_c.sync replay = 3 notifications.
        assert seen.count("node.create") == 3
        await store_a.close()
    finally:
        op_listeners.clear()


async def test_op_listener_failures_do_not_break_apply(relay):
    def bad_listener(op):
        raise RuntimeError("boom")

    op_listeners.register(bad_listener)
    try:
        store = _make_store(relay)
        await store.create_node("node-1", "page")  # must not raise
        await store.close()
    finally:
        op_listeners.clear()


async def test_relay_receive_batch_notifies_op_listeners():
    """Client-pushed envelopes (no WorkspaceStore apply) still reach listeners."""
    from app.relay.models import BatchRequest, RelayEnvelope
    from app.relay.permissions import StubPermissionChecker
    from app.relay.service import RelayService

    seen: list[str] = []
    op_listeners.register(lambda op: seen.append(op.envelope.op_type))
    try:
        service = RelayService(SqliteRelayStorage(":memory:"), StubPermissionChecker())
        envelope = RelayEnvelope(
            id="env-1",
            workspace_id=WS,
            actor_id=ACTOR,
            hlc=Hlc(physical=10, logical=0),
            affected_node_ids=[],
            op_type="node.create",
            payload={"nodeId": "node-1", "kind": "page"},
        )
        await service.receive_batch(BatchRequest(envelopes=[envelope]), ACTOR)
        assert seen == ["node.create"]
    finally:
        op_listeners.clear()


# ── Continuous service (hook, debounce, startup) ────────────────────────────


class FakeSettingsRepo:
    """Minimal settings repository fake (workspace-keyed JSON store)."""

    def __init__(self):
        self.data: dict[int, dict[str, object]] = {}

    async def get_workspace_settings(self, workspace_id: int):
        return dict(self.data.get(workspace_id, {}))

    async def set_workspace_setting(self, workspace_id, key, value, now, user_id):
        self.data.setdefault(workspace_id, {})[key] = value


def _make_context(settings_repo: FakeSettingsRepo, store: WorkspaceStore) -> PluginContext:
    async def settings_factory(workspace_id, user_id):
        return settings_repo

    async def store_factory(workspace_uuid, actor_uuid):
        return store

    return PluginContext(
        plugin_id="notees.export_profiles",
        permissions={
            "read_nodes", "read_properties", "read_assets",
            "settings", "router", "export", "background_sync",
        },
        registry=PluginRegistry(),
        port_factories={
            "SettingsRepository": settings_factory,
            "WorkspaceStore": store_factory,
        },
    )


def _make_continuous(
    context: PluginContext,
    *,
    debounce: float = 0.01,
    members: list | None = None,
    services_factory=None,
    store=None,
) -> ExportContinuousService:
    async def id_resolver(workspace_uuid, user_uuid):
        return (1, 1)

    async def member_lister():
        return members or []

    async def store_factory(workspace_uuid, actor_uuid):
        return store

    provider = BibliographicProvider()
    return ExportContinuousService(
        context,
        debounce_seconds=debounce,
        id_resolver=id_resolver,
        workspace_member_lister=member_lister,
        provider_lookup=lambda pid: provider if pid == "bibliographic" else None,
        services_factory=services_factory,
        store_factory=store_factory if store is not None else None,
    )


async def test_continuous_op_filtering(relay):
    store = _make_store(relay)
    context = _make_context(FakeSettingsRepo(), store)
    service = _make_continuous(context)
    triggered: list[tuple[str, str]] = []
    service.trigger = lambda ws, user: triggered.append((ws, user))  # type: ignore[method-assign]

    await service.handle_operation(_op("link.click"))
    await service.handle_operation(_op("activity.record"))
    assert triggered == []

    await service.handle_operation(_op("property.set"))
    await service.handle_operation(_op("asset.upload"))
    await service.handle_operation(_op("class.assign"))
    await service.handle_operation(_op("node.delete"))
    assert len(triggered) == 4
    await store.close()


async def test_continuous_debounce_coalesces(relay):
    store = _make_store(relay)
    context = _make_context(FakeSettingsRepo(), store)
    service = _make_continuous(context, debounce=0.05)
    calls: list[tuple[str, str]] = []

    async def fake_reconcile(workspace_uuid, user_uuid, **kwargs):
        calls.append((workspace_uuid, user_uuid))
        return []

    service.reconcile_for_user = fake_reconcile  # type: ignore[method-assign]

    service.trigger(WS, ACTOR)
    service.trigger(WS, ACTOR)
    service.trigger(WS, ACTOR)
    await service.flush()
    assert calls == [(WS, ACTOR)]
    await store.close()


async def test_continuous_startup_reconciles_all_members(relay):
    store = _make_store(relay)
    context = _make_context(FakeSettingsRepo(), store)
    members = [(1, WS, 1, "user-a"), (1, WS, 2, "user-b")]
    service = _make_continuous(context, members=members)
    calls: list[tuple[str, str]] = []

    async def fake_reconcile(workspace_uuid, user_uuid, **kwargs):
        calls.append((workspace_uuid, user_uuid))
        return []

    service.reconcile_for_user = fake_reconcile  # type: ignore[method-assign]
    await service.startup_reconcile()
    assert calls == [(WS, "user-a"), (WS, "user-b")]
    await store.close()


# ── Acceptance flow over a real WorkspaceStore ──────────────────────────────


async def _seed_system_schema(store: WorkspaceStore) -> None:
    """Seed the system classes/schemas the export engine resolves against.

    Production workspaces get these from ``app/core/seed.py`` at creation;
    the in-memory test workspace needs the subset the engine joins on.
    """
    source = SYSTEM_CLASS_UUIDS["source"]
    await store.create_class(source, "source")
    await store.create_class(BOOK, "book", extends_class_ids=[source])
    await store.create_class(COLLECTION, "collection")
    await store.create_class(SYSTEM_CLASS_UUIDS["asset"], "asset")
    await store.create_property_schema(ATTACHMENTS, "attachments", "node", multi=True)
    await store.create_property_schema(CITEKEY, "citekey", "text")
    await store.create_property_schema(ROLE, "role", "selection")
    await store.create_property_schema(PUB_DATE, "publication_date", "date")
    await store.create_property_schema(SYSTEM_PROPERTY_UUIDS["authors"], "authors", "node", multi=True)
    await store.sync()


@pytest_asyncio.fixture
async def acceptance(tmp_path, relay):
    """Real store + real services + continuous service with zero debounce."""
    from app.features.assets.service import AssetFileService, AssetService

    store = _make_store(relay)
    await _seed_system_schema(store)
    assets_dir = tmp_path / "assets"
    asset_service = AssetService(WS, ACTOR, store, assets_dir=assets_dir)
    settings_repo = FakeSettingsRepo()
    context = _make_context(settings_repo, store)
    service = _make_continuous(
        context,
        debounce=0.0,
        services_factory=lambda s: WorkspaceExportServices(
            s, AssetFileService(WS, assets_dir)
        ),
        store=store,
    )
    yield store, asset_service, settings_repo, service, tmp_path
    await store.close()


async def _make_book_with_attachment(store, asset_service, tmp_path, *, citekey="herbert1965", title="dune"):
    source_uuid = uuidv7()
    await store.create_node(
        source_uuid,
        "page",
        initial_content=[{"type": "paragraph", "children": [{"text": title}]}],
        class_ids=[BOOK],
    )
    asset = await asset_service.upload_asset(
        file_bytes=b"fake-epub-bytes",
        filename=f"{title}.epub",
        content_type="application/epub+zip",
    )
    await store.set_property(
        property_value_id=uuidv7(),
        node_id=source_uuid,
        schema_id=ATTACHMENTS,
        value=asset["uuid"],
    )
    await store.set_property(
        property_value_id=uuidv7(),
        node_id=asset["uuid"],
        schema_id=ROLE,
        value="representation",
    )
    if citekey is not None:
        await store.set_property(
            property_value_id=uuidv7(),
            node_id=source_uuid,
            schema_id=CITEKEY,
            value=citekey,
        )
    await store.sync()
    return source_uuid, asset["uuid"]


async def test_acceptance_upload_rename_detach_and_startup(acceptance):
    store, asset_service, settings_repo, service, tmp_path = acceptance
    export_root = tmp_path / "exports"
    settings_repo.data.setdefault(1, {})["plugin:notees.export_profiles:export_root"] = str(
        export_root
    )
    profile = _profile(tmp_path)
    settings_repo.data[1]["plugin:notees.export_profiles:profiles"] = [profile.to_dict()]

    source_uuid, asset_uuid = await _make_book_with_attachment(store, asset_service, tmp_path)

    # Continuous reconciliation (zero debounce) creates the file.
    reports = await service.reconcile_for_user(WS, ACTOR)
    expected = export_root / ACTOR / "books" / "book" / "herbert1965.epub"
    assert expected.read_bytes() == b"fake-epub-bytes"
    assert reports[0].created == ["book/herbert1965.epub"]

    # Second run is a no-op (byte-identical tree).
    reports = await service.reconcile_for_user(WS, ACTOR)
    assert reports[0].unchanged == 1

    # Citekey edit → file moves.
    await store.set_property(
        property_value_id=uuidv7(), node_id=source_uuid, schema_id=CITEKEY, value="herbert1969"
    )
    await store.sync()
    reports = await service.reconcile_for_user(WS, ACTOR)
    moved = export_root / ACTOR / "books" / "book" / "herbert1969.epub"
    assert moved.exists()
    assert not expected.exists()
    assert reports[0].deleted == ["book/herbert1965.epub"]

    # Detach the asset → managed file is deleted, source lands in skip report.
    await store.unset_property(source_uuid, ATTACHMENTS, index=0)
    await store.sync()
    reports = await service.reconcile_for_user(WS, ACTOR)
    assert not moved.exists()
    assert reports[0].deleted == ["book/herbert1969.epub"]
    assert [s["node_uuid"] for s in reports[0].skipped] == [source_uuid]


async def test_acceptance_two_users_disjoint_roots(acceptance):
    store, asset_service, settings_repo, service, tmp_path = acceptance
    export_root = tmp_path / "exports"
    settings_repo.data.setdefault(1, {})["plugin:notees.export_profiles:export_root"] = str(
        export_root
    )
    profile = _profile(tmp_path)
    settings_repo.data[1]["plugin:notees.export_profiles:profiles"] = [profile.to_dict()]
    await _make_book_with_attachment(store, asset_service, tmp_path)

    await service.reconcile_for_user(WS, "user-a")
    await service.reconcile_for_user(WS, "user-b")

    tree_a = export_root / "user-a" / "books" / "book" / "herbert1965.epub"
    tree_b = export_root / "user-b" / "books" / "book" / "herbert1965.epub"
    assert tree_a.exists() and tree_b.exists()
    assert tree_a != tree_b


async def test_acceptance_collection_profile_tracks_membership(acceptance):
    store, asset_service, settings_repo, service, tmp_path = acceptance
    export_root = tmp_path / "exports"
    settings_repo.data.setdefault(1, {})["plugin:notees.export_profiles:export_root"] = str(
        export_root
    )

    collection_uuid = uuidv7()
    await store.create_node(
        collection_uuid,
        "page",
        initial_content=[{"type": "paragraph", "children": [{"text": "Sci-Fi"}]}],
        class_ids=[COLLECTION],
    )
    # Membership = nesting: sources under the collection node.
    query = {
        "ast": {
            "type": "query",
            "version": "1.0",
            "scope": {"type": "scope", "scope_type": "entire_workspace"},
            "root_group": {
                "type": "group",
                "logic": "AND",
                "children": [
                    {
                        "type": "condition",
                        "condition_type": "parent_path",
                        "nested_group": {
                            "type": "group",
                            "logic": "AND",
                            "children": [
                                {
                                    "type": "condition",
                                    "condition_type": "property",
                                    "property_name": "uuid",
                                    "property_type": "text",
                                    "operator": "equals",
                                    "value": collection_uuid,
                                }
                            ],
                        },
                    }
                ],
            },
        }
    }
    profile = _profile(tmp_path, query=query)
    settings_repo.data[1]["plugin:notees.export_profiles:profiles"] = [profile.to_dict()]

    source_uuid, _ = await _make_book_with_attachment(store, asset_service, tmp_path)

    # Not yet a member → nothing exported.
    await service.reconcile_for_user(WS, ACTOR)
    assert not (export_root / ACTOR / "books" / "book" / "herbert1965.epub").exists()

    # Nest the source under the collection → file appears.
    await store.move_node(source_uuid, new_parent_id=collection_uuid)
    await store.sync()
    await service.reconcile_for_user(WS, ACTOR)
    exported = export_root / ACTOR / "books" / "book" / "herbert1965.epub"
    assert exported.exists()

    # Move it back out → file disappears.
    await store.move_node(source_uuid, new_parent_id=None)
    await store.sync()
    reports = await service.reconcile_for_user(WS, ACTOR)
    assert not exported.exists()
    assert reports[0].deleted == ["book/herbert1965.epub"]


async def test_acceptance_source_deleted_removes_file(acceptance):
    store, asset_service, settings_repo, service, tmp_path = acceptance
    export_root = tmp_path / "exports"
    settings_repo.data.setdefault(1, {})["plugin:notees.export_profiles:export_root"] = str(
        export_root
    )
    profile = _profile(tmp_path)
    settings_repo.data[1]["plugin:notees.export_profiles:profiles"] = [profile.to_dict()]
    source_uuid, _ = await _make_book_with_attachment(store, asset_service, tmp_path)

    await service.reconcile_for_user(WS, ACTOR)
    exported = export_root / ACTOR / "books" / "book" / "herbert1965.epub"
    assert exported.exists()

    await store.delete_node(source_uuid)
    await store.sync()
    reports = await service.reconcile_for_user(WS, ACTOR)
    assert not exported.exists()
    assert reports[0].deleted == ["book/herbert1965.epub"]


async def test_acceptance_startup_rebuilds_tree_from_scratch(acceptance):
    store, asset_service, settings_repo, service, tmp_path = acceptance
    export_root = tmp_path / "exports"
    settings_repo.data.setdefault(1, {})["plugin:notees.export_profiles:export_root"] = str(
        export_root
    )
    profile = _profile(tmp_path)
    settings_repo.data[1]["plugin:notees.export_profiles:profiles"] = [profile.to_dict()]
    await _make_book_with_attachment(store, asset_service, tmp_path)

    # Startup pass with a fresh (empty) state produces the correct tree.
    service._workspace_member_lister = lambda: asyncio.sleep(  # type: ignore[method-assign]
        0, result=[(1, WS, 1, ACTOR)]
    )
    await service.startup_reconcile()
    exported = export_root / ACTOR / "books" / "book" / "herbert1965.epub"
    assert exported.read_bytes() == b"fake-epub-bytes"


async def test_hook_triggers_reconciliation_end_to_end(acceptance):
    """The registered op listener fires on store ops and reconciles (Decision 13)."""
    store, asset_service, settings_repo, service, tmp_path = acceptance
    export_root = tmp_path / "exports"
    settings_repo.data.setdefault(1, {})["plugin:notees.export_profiles:export_root"] = str(
        export_root
    )
    profile = _profile(tmp_path)
    settings_repo.data[1]["plugin:notees.export_profiles:profiles"] = [profile.to_dict()]

    op_listeners.register(service.handle_operation)
    try:
        source_uuid, asset_uuid = await _make_book_with_attachment(
            store, asset_service, tmp_path
        )
        await service.flush()
        exported = export_root / ACTOR / "books" / "book" / "herbert1965.epub"
        assert exported.exists()
    finally:
        op_listeners.clear()
