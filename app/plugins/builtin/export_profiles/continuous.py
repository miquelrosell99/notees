"""Continuous reconciliation (Decision 13).

A post-commit operation listener (asset/property/class/node ops) schedules a
debounced re-resolution of the workspace's enabled profiles for the acting
user, and a startup hook repairs drift by reconciling every workspace
member's tree. The export folder is therefore a continuously maintained
derived view of the graph: renames, deletions, and selection changes
propagate without manual re-runs.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from app.core.operation import Operation
from app.logging_config import get_logger
from app.plugins.core.export import ExportProvider
from app.utils.datetime_utils import utc_now

from .engine.runner import ReconcileReport, reconcile_profile
from .paths import EXPORT_ROOT_SETTING_KEY, profile_destination_root
from .profiles import PROFILES_SETTING_KEY, parse_profiles
from .services import WorkspaceExportServices
from .state import (
    STATE_SETTING_KEY,
    get_profile_state,
    put_profile_state,
)

if TYPE_CHECKING:
    from app.core.workspace_store import WorkspaceStore
    from app.plugins.core.context import PluginContext

logger = get_logger(__name__)

# Op-type prefixes that can change a profile's selection, tokens, or blobs.
_RELEVANT_OP_PREFIXES = (
    "node.",
    "property.",
    "class.",
    "asset.",
    "propertySchema.",
    "classPropertyEdge.",
)

# (workspace_id, workspace_uuid, user_id, user_uuid)
WorkspaceMember = tuple[int, str, int, str]

IdResolver = Callable[[str, str], Awaitable[tuple[int, int] | None]]
WorkspaceMemberLister = Callable[[], Awaitable[list[WorkspaceMember]]]
ProviderLookup = Callable[[str], ExportProvider | None]


async def _default_id_resolver(workspace_uuid: str, user_uuid: str) -> tuple[int, int] | None:
    """Resolve (workspace_id, user_id) integer ids from UUIDs via PostgreSQL."""
    from app.db.connection import acquire_connection, get_pool

    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        workspace_id = await conn.fetchval(
            "SELECT id FROM workspace WHERE uuid = $1", workspace_uuid
        )
        if workspace_id is None:
            return None
        user_id = await conn.fetchval(
            'SELECT id FROM "user" WHERE uuid = $1', user_uuid
        )
        if user_id is None:
            return None
    return int(workspace_id), int(user_id)


async def _default_workspace_member_lister() -> list[WorkspaceMember]:
    """Enumerate (workspace, member) pairs for startup reconciliation."""
    from app.db.connection import acquire_connection, get_pool

    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            """
            SELECT w.id AS workspace_id, w.uuid AS workspace_uuid,
                   u.id AS user_id, u.uuid AS user_uuid
            FROM workspace w
            JOIN "user" u ON u.id = w.create_uid
            UNION
            SELECT w.id AS workspace_id, w.uuid AS workspace_uuid,
                   u.id AS user_id, u.uuid AS user_uuid
            FROM workspace_share gs
            JOIN workspace w ON w.id = gs.workspace_id
            JOIN "user" u ON u.id = gs.user_id
            WHERE gs.active = TRUE
            """
        )
    return [
        (int(row["workspace_id"]), str(row["workspace_uuid"]), int(row["user_id"]), str(row["user_uuid"]))
        for row in rows
    ]


class ExportContinuousService:
    """Debounced continuous reconciliation of export profiles."""

    def __init__(
        self,
        context: PluginContext,
        *,
        debounce_seconds: float = 2.0,
        id_resolver: IdResolver = _default_id_resolver,
        workspace_member_lister: WorkspaceMemberLister = _default_workspace_member_lister,
        provider_lookup: ProviderLookup | None = None,
        store_factory: Callable[[str, str], Awaitable[WorkspaceStore]] | None = None,
        services_factory: Callable[[WorkspaceStore], Any] | None = None,
    ) -> None:
        self._context = context
        self._debounce_seconds = debounce_seconds
        self._id_resolver = id_resolver
        self._workspace_member_lister = workspace_member_lister
        self._provider_lookup = provider_lookup or self._registry_provider_lookup
        self._store_factory = store_factory
        self._services_factory = services_factory or (
            lambda store: WorkspaceExportServices(store)
        )
        self._pending: dict[tuple[str, str], asyncio.Task[None]] = {}
        self._reconcile_locks: dict[tuple[str, str], asyncio.Lock] = {}

    # ── Post-commit hook ────────────────────────────────────────────────

    async def handle_operation(self, operation: Operation) -> None:
        """Operation-listener entry point: filter and schedule reconciliation."""
        op_type = operation.envelope.op_type
        if not op_type.startswith(_RELEVANT_OP_PREFIXES):
            return
        self.trigger(
            operation.envelope.workspace_id,
            operation.envelope.actor_id,
        )

    def trigger(self, workspace_uuid: str, user_uuid: str) -> asyncio.Task[None]:
        """Schedule a debounced reconciliation for (workspace, user)."""
        key = (workspace_uuid, user_uuid)
        existing = self._pending.get(key)
        if existing is not None and not existing.done():
            existing.cancel()
        task = asyncio.create_task(self._debounced(key))
        self._pending[key] = task
        return task

    async def _debounced(self, key: tuple[str, str]) -> None:
        try:
            await asyncio.sleep(self._debounce_seconds)
            await self.reconcile_for_user(*key)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception(
                "Continuous export reconciliation failed for workspace %s user %s",
                key[0],
                key[1],
            )
        finally:
            if self._pending.get(key) is asyncio.current_task():
                self._pending.pop(key, None)

    async def flush(self) -> None:
        """Await all pending debounced reconciliations (tests/shutdown)."""
        tasks = [task for task in self._pending.values() if not task.done()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # ── Reconciliation ──────────────────────────────────────────────────

    async def reconcile_for_user(
        self,
        workspace_uuid: str,
        user_uuid: str,
        *,
        only_profile_id: str | None = None,
        include_disabled: bool = False,
    ) -> list[ReconcileReport]:
        """Reconcile a user's export trees against the current selection.

        Serializes per (workspace, user) so a manual run cannot interleave
        with a debounced run and corrupt the managed state.
        """
        key = (workspace_uuid, user_uuid)
        lock = self._reconcile_locks.setdefault(key, asyncio.Lock())
        async with lock:
            return await self._reconcile_for_user_locked(
                workspace_uuid,
                user_uuid,
                only_profile_id=only_profile_id,
                include_disabled=include_disabled,
            )

    async def _reconcile_for_user_locked(
        self,
        workspace_uuid: str,
        user_uuid: str,
        *,
        only_profile_id: str | None,
        include_disabled: bool,
    ) -> list[ReconcileReport]:
        ids = await self._id_resolver(workspace_uuid, user_uuid)
        if ids is None:
            logger.warning(
                "Skipping export reconciliation: cannot resolve ids for "
                "workspace %s user %s",
                workspace_uuid,
                user_uuid,
            )
            return []
        workspace_id, user_id = ids

        raw_profiles = await self._context.get_setting(
            workspace_id, user_id, PROFILES_SETTING_KEY, []
        )
        profiles = parse_profiles(raw_profiles)
        if only_profile_id is not None:
            profiles = [p for p in profiles if p.id == only_profile_id]
        if not include_disabled:
            profiles = [p for p in profiles if p.enabled]
        if not profiles:
            return []

        custom_root = await self._context.get_setting(
            workspace_id, user_id, EXPORT_ROOT_SETTING_KEY, None
        )
        state = await self._context.get_setting(
            workspace_id, user_id, STATE_SETTING_KEY, {}
        )
        if not isinstance(state, dict):
            state = {}

        store, owns_store = await self._open_store(workspace_uuid, user_uuid)
        try:
            services = self._services_factory(store)
            reports: list[ReconcileReport] = []
            for profile in profiles:
                run_state = get_profile_state(state, user_uuid, profile.id)
                try:
                    root = profile_destination_root(
                        custom_root, user_uuid, profile.slug, profile.destination
                    )
                    report, new_managed = await reconcile_profile(
                        profile,
                        root,
                        run_state.managed,
                        services,
                        self._provider_lookup,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.exception(
                        "Export profile %s reconciliation failed", profile.id
                    )
                    report = ReconcileReport(
                        profile_id=profile.id,
                        profile_slug=profile.slug,
                        root="",
                        errors=[{"relative_path": "", "asset_uuid": "", "reason": str(exc)}],
                    )
                    new_managed = run_state.managed
                run_state.managed = new_managed
                run_state.last_run = utc_now().isoformat()
                run_state.report = report.to_dict()
                state = put_profile_state(state, user_uuid, profile.id, run_state)
                reports.append(report)
        finally:
            if owns_store:
                await store.close()

        await self._context.set_setting(workspace_id, user_id, STATE_SETTING_KEY, state)
        return reports

    async def startup_reconcile(self) -> None:
        """Startup pass: reconcile enabled profiles for every workspace member."""
        members = await self._workspace_member_lister()
        for _workspace_id, workspace_uuid, _user_id, user_uuid in members:
            try:
                await self.reconcile_for_user(workspace_uuid, user_uuid)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Startup export reconciliation failed for workspace %s user %s",
                    workspace_uuid,
                    user_uuid,
                )

    # ── Helpers ─────────────────────────────────────────────────────────

    def _registry_provider_lookup(self, provider_id: str) -> ExportProvider | None:
        return self._context.registry.get_export_provider(provider_id)

    async def _open_store(
        self, workspace_uuid: str, user_uuid: str
    ) -> tuple[WorkspaceStore, bool]:
        """Return (store, owned). Injected stores are caller-owned (not closed)."""
        if self._store_factory is not None:
            return await self._store_factory(workspace_uuid, user_uuid), False
        factory = self._context.get_port("WorkspaceStore")
        return await factory(workspace_uuid, user_uuid), True


def relevant_op_types() -> tuple[str, ...]:
    """Expose the op-type prefixes the listener reacts to (documentation/tests)."""
    return _RELEVANT_OP_PREFIXES
