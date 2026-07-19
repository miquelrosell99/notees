"""PluginContext passed to backend plugin setup functions."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.utils.datetime_utils import utc_now

from .exceptions import PluginPermissionError
from .ports import (
    ClassSideEffectHandler,
    ExporterAdapter,
    ImporterAdapter,
    RouterRegistration,
    SettingSchema,
    SyncSource,
)

if TYPE_CHECKING:
    from app.domain.repositories.interfaces import SettingsRepository

    from .registry import PluginRegistry


# Port factories may take UUID strings (WorkspaceStore) or integer ids
# (legacy/global repositories). The exact signature is defined by the registered
# factory and enforced at call sites.
PortFactory = Callable[..., Awaitable[Any]]


def _content_to_text(raw_content: str | None) -> str | None:
    """Extract plain text from a node's JSON content, falling back to None."""
    if not raw_content:
        return None
    try:
        content = json.loads(raw_content)
    except (ValueError, TypeError):
        return None

    def _walk(node: Any) -> str:
        if isinstance(node, dict):
            if "text" in node:
                text = node["text"]
                if isinstance(text, str):
                    return text
                return ""
            return "".join(_walk(child) for child in node.get("children", []))
        if isinstance(node, list):
            return "".join(_walk(child) for child in node)
        if isinstance(node, str):
            return node
        return ""

    text = _walk(content).strip()
    return text or None


class PluginContext:
    """Runtime context passed to a plugin's backend setup() function.

    The context exposes extension-point registration methods and a small set of
    core service factories. All registration methods validate that the plugin
    has declared the required permission in its manifest.

    During Phase 7 the mutable-row node/property services are replaced by
    :class:`app.core.workspace_store.WorkspaceStore`. Helpers that read or write
    workspace data now operate on UUID strings and emit operations into the
    local-first operation log.
    """

    def __init__(
        self,
        plugin_id: str,
        permissions: set[str],
        registry: PluginRegistry,
        port_factories: dict[str, PortFactory],
    ) -> None:
        self.plugin_id = plugin_id
        self.permissions = permissions
        self.registry = registry
        self.port_factories = port_factories

    # Permissions required to obtain a core service factory via get_port().
    _PORT_PERMISSIONS: dict[str, set[str]] = {
        "WorkspaceStore": {
            "read_nodes",
            "write_nodes",
            "read_properties",
            "write_properties",
            "read_assets",
            "write_assets",
            "background_sync",
            "export",
            "import",
            "router",
        },
        "SettingsRepository": {"settings"},
    }

    def _require(self, permission: str) -> None:
        if permission not in self.permissions:
            raise PluginPermissionError(
                self.plugin_id,
                f"Missing permission '{permission}' for this operation",
            )

    def _require_any(self, permissions: set[str]) -> None:
        if not self.permissions.intersection(permissions):
            raise PluginPermissionError(
                self.plugin_id,
                f"Missing one of permissions {sorted(permissions)} for this operation",
            )

    def get_port(self, name: str) -> PortFactory:
        """Return a factory for a core domain service.

        The factory accepts arguments defined by the registered port:

        - ``WorkspaceStore``: ``(workspace_uuid: str, actor_uuid: str)``.
        - ``SettingsRepository``: ``(workspace_id: int, user_id: int)``.

        Available ports depend on what the PluginManager has registered and
        which permissions the plugin declared.
        """
        required = self._PORT_PERMISSIONS.get(name)
        if required is not None:
            self._require_any(required)

        factory = self.port_factories.get(name)
        if factory is None:
            raise PluginPermissionError(
                self.plugin_id, f"Core port '{name}' is not available to plugins"
            )
        return factory

    def register_router(self, router: APIRouter, prefix: str) -> None:
        """Register a FastAPI router under ``/api/plugins/<plugin_id>/<prefix>``."""
        self._require("router")
        self.registry.add_router(self.plugin_id, router, prefix)

    def register_importer(self, adapter: ImporterAdapter) -> None:
        """Register an importer adapter."""
        self._require("import")
        self.registry.add_importer(self.plugin_id, adapter)

    def register_exporter(self, adapter: ExporterAdapter) -> None:
        """Register an export format adapter."""
        self._require("export")
        adapter._plugin_id = self.plugin_id  # type: ignore[attr-defined]
        self.registry.add_exporter(self.plugin_id, adapter)

    def register_sync_source(self, source: SyncSource) -> None:
        """Register a pull-only sync source."""
        self._require("background_sync")
        source._plugin_id = self.plugin_id  # type: ignore[attr-defined]
        self.registry.add_sync_source(self.plugin_id, source)

    def register_setting(self, schema: SettingSchema) -> None:
        """Register a workspace-scoped plugin setting schema."""
        self._require("settings")
        self.registry.add_setting(self.plugin_id, schema)

    def register_node_class_side_effect(
        self, class_uuid: str, handler: ClassSideEffectHandler
    ) -> None:
        """Register a handler invoked when a node gains or loses a class."""
        self._require("write_nodes")
        handler._plugin_id = self.plugin_id  # type: ignore[attr-defined]
        self.registry.add_class_side_effect(class_uuid, handler)

    def _settings_key(self, key: str) -> str:
        """Namespace a plugin setting under its plugin id."""
        return f"plugin:{self.plugin_id}:{key}"

    async def _get_workspace_store(
        self, workspace_uuid: str, actor_uuid: str
    ) -> WorkspaceStore:
        """Return a WorkspaceStore scoped to the given workspace/actor."""
        factory = self.get_port("WorkspaceStore")
        store: WorkspaceStore = await factory(workspace_uuid, actor_uuid)
        return store

    async def get_setting(
        self, workspace_id: int, user_id: int, key: str, default: Any = None
    ) -> Any:
        """Read a workspace-scoped plugin setting.

        Settings still live in PostgreSQL, so this helper continues to use
        integer workspace/user ids for the settings repository.
        """
        factory = self.get_port("SettingsRepository")
        repo: SettingsRepository = await factory(workspace_id, user_id)
        settings = await repo.get_workspace_settings(workspace_id)
        return settings.get(self._settings_key(key), default)

    async def set_setting(
        self, workspace_id: int, user_id: int, key: str, value: Any
    ) -> None:
        """Write a workspace-scoped plugin setting."""
        factory = self.get_port("SettingsRepository")
        repo: SettingsRepository = await factory(workspace_id, user_id)
        await repo.set_workspace_setting(
            workspace_id,
            self._settings_key(key),
            value,
            utc_now(),
            user_id,
        )

    async def emit_op(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        op_type: str,
        data: dict[str, Any],
        node_id: str | None = None,
    ) -> None:
        """Emit a ``plugin.op`` operation for this plugin.

        The operation is encrypted and persisted through the relay, then applied
        to the derived SQLite state via the ``plugin_op_log`` table.
        """
        store = await self._get_workspace_store(workspace_uuid, actor_uuid)
        try:
            await store.plugin_op(self.plugin_id, op_type, data, node_id=node_id)
        finally:
            await store.close()

    async def ensure_class(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        name: str,
        icon: str | None = None,
    ) -> str:
        """Return the UUID of a class with the given name, creating it if needed.

        System classes are resolved from :data:`SYSTEM_CLASS_UUIDS`. For
        user-created classes the derived state currently does not store class
        names, so a new ``class.create`` operation is emitted each time. Once
        the derived schema materialises class names this helper will become
        fully idempotent.
        """
        self._require("write_nodes")
        for class_name, class_uuid in SYSTEM_CLASS_UUIDS.items():
            if class_name == name:
                return class_uuid

        store = await self._get_workspace_store(workspace_uuid, actor_uuid)
        try:
            class_uuid = uuidv7()
            await store.create_class(class_id=class_uuid, name=name)
            return class_uuid
        finally:
            await store.close()

    async def ensure_property_schema(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        name: str,
        prop_type: str = "text",
        icon: str | None = None,
    ) -> str:
        """Return the UUID of a property schema with the given name.

        Property schemas are not materialised in the derived SQLite state, so a
        new ``propertySchema.create`` operation is emitted on each call. Plugins
        that need idempotent schema creation should store the generated UUID in
        their own derived rows via :meth:`emit_op`.
        """
        self._require("write_properties")
        store = await self._get_workspace_store(workspace_uuid, actor_uuid)
        try:
            schema_uuid = uuidv7()
            await store.create_property_schema(
                schema_id=schema_uuid, name=name, prop_type=prop_type
            )
            return schema_uuid
        finally:
            await store.close()

    async def find_page_by_name(
        self, workspace_uuid: str, actor_uuid: str, name: str
    ) -> str | None:
        """Return the UUID of the first active page whose text content matches ``name``."""
        self._require("read_nodes")
        store = await self._get_workspace_store(workspace_uuid, actor_uuid)
        try:
            await store.sync()
            rows = await store.query("SELECT id, content FROM node WHERE kind = 'page'")
            for row in rows:
                if _content_to_text(row["content"]) == name:
                    return row["id"]
            return None
        finally:
            await store.close()

    async def create_page(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        name: str,
        class_uuids: list[str] | None = None,
        property_values: dict[str, Any] | None = None,
        icon: str | None = None,
    ) -> str:
        """Create a page node with optional classes and property values.

        Returns the UUID of the newly created page.
        """
        self._require("write_nodes")
        store = await self._get_workspace_store(workspace_uuid, actor_uuid)
        try:
            node_uuid = uuidv7()
            initial_content: list[dict[str, Any]] = [
                {
                    "type": "paragraph",
                    "children": [{"text": name}],
                }
            ]
            await store.create_node(
                node_id=node_uuid,
                kind="page",
                initial_content=initial_content,
                class_ids=class_uuids or [],
            )
            if icon is not None:
                await store.set_property(
                    property_value_id=uuidv7(),
                    node_id=node_uuid,
                    schema_id="system:icon",
                    value=icon,
                )
            for schema_uuid, value in (property_values or {}).items():
                await store.set_property(
                    property_value_id=uuidv7(),
                    node_id=node_uuid,
                    schema_id=schema_uuid,
                    value=value,
                )
            return node_uuid
        finally:
            await store.close()

    async def create_node(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        node_id: str,
        kind: str,
        parent_id: str | None = None,
        index: int = 0,
        initial_content: list[dict[str, Any]] | None = None,
        class_uuids: list[str] | None = None,
    ) -> str:
        """Create an arbitrary node.

        Returns the supplied ``node_id`` for convenience.
        """
        self._require("write_nodes")
        store = await self._get_workspace_store(workspace_uuid, actor_uuid)
        try:
            await store.create_node(
                node_id=node_id,
                kind=kind,
                parent_id=parent_id,
                index=index,
                initial_content=initial_content,
                class_ids=class_uuids or [],
            )
            return node_id
        finally:
            await store.close()

    async def update_content(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        node_id: str,
        content: list[dict[str, Any]],
    ) -> None:
        """Update a node's content AST."""
        self._require("write_nodes")
        store = await self._get_workspace_store(workspace_uuid, actor_uuid)
        try:
            await store.update_content(node_id, content)
        finally:
            await store.close()

    async def move_node(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        node_id: str,
        new_parent_id: str | None = None,
        new_index: int = 0,
    ) -> None:
        """Move a node to a new parent and/or index."""
        self._require("write_nodes")
        store = await self._get_workspace_store(workspace_uuid, actor_uuid)
        try:
            await store.move_node(node_id, new_parent_id, new_index)
        finally:
            await store.close()

    async def _find_page_by_name_and_classes(
        self, store: WorkspaceStore, name: str, class_uuids: set[str]
    ) -> str | None:
        """Return the first page with ``name`` and any of ``class_uuids``."""
        rows = await store.query(
            "SELECT id, content, class_ids FROM node WHERE kind = 'page'"
        )
        for row in rows:
            if _content_to_text(row["content"]) != name:
                continue
            node_classes = set(json.loads(row["class_ids"]) or [])
            if class_uuids and not class_uuids.intersection(node_classes):
                continue
            return row["id"]
        return None

    async def upsert_page_by_external_id(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        external_id: str,
        *,
        external_id_schema_uuid: str,
        name: str,
        class_uuids: list[str] | None = None,
        property_values: dict[str, Any] | None = None,
        icon: str | None = None,
    ) -> str:
        """Find or create a page mapped by an external identity property.

        The external id is stored on the page as ``external_id_schema_uuid`` so
        that renames on either side do not break the mapping. If the page
        already exists, its name and property values are refreshed.

        If no page carries the external id, the helper falls back to matching by
        ``name`` and any of ``class_uuids``. All integer identifiers have been
        replaced by UUID strings.
        """
        self._require("write_nodes")
        store = await self._get_workspace_store(workspace_uuid, actor_uuid)
        class_set = set(class_uuids or [])
        try:
            await store.sync()
            rows = await store.query(
                "SELECT node_id FROM property_value "
                "WHERE property_schema_id = ? AND value = ?",
                (external_id_schema_uuid, json.dumps(external_id)),
            )
            if rows:
                node_uuid = rows[0]["node_id"]
            else:
                node_uuid = await self._find_page_by_name_and_classes(
                    store, name, class_set
                )

            if node_uuid is not None:
                await store.update_content(
                    node_uuid,
                    [
                        {
                            "type": "paragraph",
                            "children": [{"text": name}],
                        }
                    ],
                )
                all_properties = {
                    **(property_values or {}),
                    external_id_schema_uuid: external_id,
                }
                for schema_uuid, value in all_properties.items():
                    await store.set_property(
                        property_value_id=uuidv7(),
                        node_id=node_uuid,
                        schema_id=schema_uuid,
                        value=value,
                    )
                return node_uuid

            return await self.create_page(
                workspace_uuid,
                actor_uuid,
                name,
                class_uuids=class_uuids,
                property_values={
                    **(property_values or {}),
                    external_id_schema_uuid: external_id,
                },
                icon=icon,
            )
        finally:
            await store.close()

    def get_registered_routers(self) -> list[RouterRegistration]:
        """Return router registrations for this plugin (convenience)."""
        reg = self.registry.get_router_registration(self.plugin_id)
        return [reg] if reg else []
