"""PluginContext passed to backend plugin setup functions."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter

from app.domain.entities import Node, NodeCreateData, NodeUpdateData
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.domain.entities.property import PropertyScope, PropertyType
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
    from app.features.nodes.node_service import NodeService
    from app.features.nodes.port import NodeRepository
    from app.features.properties.service import PropertyService

    from .registry import PluginRegistry


PortFactory = Callable[[int, int], Awaitable[Any]]


class PluginContext:
    """Runtime context passed to a plugin's backend setup() function.

    The context exposes extension-point registration methods and a small set of
    core domain-service factories. All registration methods validate that the
    plugin has declared the required permission in its manifest.
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
        "NodeService": {"read_nodes", "write_nodes"},
        "NodeRepository": {"read_nodes", "write_nodes"},
        "PropertyService": {"read_properties", "write_properties"},
        "PropertyRepository": {"read_properties", "write_properties"},
        "AssetService": {"read_assets", "write_assets"},
        "AssetRepository": {"read_assets", "write_assets"},
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

        The factory accepts ``(workspace_id, user_id)`` and returns a service
        instance scoped to that workspace/user. Available ports depend on what
        the PluginManager has registered and which permissions the plugin
        declared.
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

    async def get_setting(
        self, workspace_id: int, user_id: int, key: str, default: Any = None
    ) -> Any:
        """Read a workspace-scoped plugin setting."""
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

    async def _get_node_service(self, workspace_id: int, user_id: int) -> NodeService:
        factory = self.get_port("NodeService")
        return await factory(workspace_id, user_id)

    async def _get_node_repository(
        self, workspace_id: int, user_id: int
    ) -> NodeRepository:
        factory = self.get_port("NodeRepository")
        return await factory(workspace_id, user_id)

    async def _get_property_service(
        self, workspace_id: int, user_id: int
    ) -> PropertyService:
        factory = self.get_port("PropertyService")
        return await factory(workspace_id, user_id)

    async def _find_class_by_name(
        self, node_repo: NodeRepository, name: str
    ) -> Node | None:
        """Find an existing class node by exact name."""
        classes = await node_repo.list_classes()
        for cls in classes:
            if cls.name == name:
                return cls
        return None

    async def ensure_class(
        self,
        workspace_id: int,
        user_id: int,
        name: str,
        icon: str | None = None,
    ) -> int:
        """Return the id of a class with the given name, creating it if needed."""
        self._require("write_nodes")
        node_repo = await self._get_node_repository(workspace_id, user_id)
        node_service = await self._get_node_service(workspace_id, user_id)

        existing = await self._find_class_by_name(node_repo, name)
        if existing and existing.id is not None:
            return existing.id

        class_class = await node_repo.find_node_id_by_uuid(SYSTEM_CLASS_UUIDS["class"])
        if class_class is None:
            raise RuntimeError("System 'class' class not found")
        data = NodeCreateData(
            name=name,
            icon=icon,
            classes=[class_class],
        )
        node = await node_service.create_node(data, user_id=user_id)
        if node.id is None:
            raise RuntimeError(f"Failed to create class '{name}'")
        return node.id

    async def ensure_property(
        self,
        workspace_id: int,
        user_id: int,
        name: str,
        prop_type: PropertyType = PropertyType.TEXT,
        icon: str | None = None,
    ) -> int:
        """Return the id of a global property with the given name, creating it if needed."""
        self._require("write_nodes")
        prop_service = await self._get_property_service(workspace_id, user_id)

        for prop in await prop_service.list_properties():
            if prop.name == name and prop.id is not None:
                return prop.id

        try:
            created = await prop_service.create_property(
                name=name,
                prop_type=prop_type,
                scope=PropertyScope.GLOBAL,
                icon=icon,
            )
        except ValueError:
            # Another concurrent caller created it; fetch and return.
            for prop in await prop_service.list_properties():
                if prop.name == name and prop.id is not None:
                    return prop.id
            raise RuntimeError(f"Failed to create property '{name}'") from None

        if created.id is None:
            raise RuntimeError(f"Failed to create property '{name}'")
        return created.id

    async def create_page(
        self,
        workspace_id: int,
        user_id: int,
        name: str,
        additional_classes: list[int] | None = None,
        property_values: dict[int, Any] | None = None,
        icon: str | None = None,
    ) -> Node:
        """Create a page node with optional classes and property values."""
        self._require("write_nodes")
        node_service = await self._get_node_service(workspace_id, user_id)
        node = await node_service.create_page(
            name=name,
            icon=icon,
            additional_classes=additional_classes,
            user_id=user_id,
        )
        if node.id is not None and property_values:
            await node_service.apply_node_extras(node.id, classes=None, properties=property_values)
            node = await node_service.get_node_by_id(node.id) or node
        return node

    async def _find_node_by_property_value(
        self,
        prop_service: PropertyService,
        property_id: int,
        value: str,
    ) -> int | None:
        """Find the first page whose scalar property equals ``value``."""
        candidates = await prop_service.get_nodes_with_property(property_id)
        for candidate in candidates:
            if not candidate.get("is_page"):
                continue
            prop_data = candidate.get("properties", {}).get(property_id)
            if not prop_data:
                continue
            for scalar in prop_data.get("values", []):
                if getattr(scalar, "value_text", None) == value:
                    return candidate["node_id"]
        return None

    async def _find_page_by_name_and_classes(
        self,
        node_repo: NodeRepository,
        name: str,
        class_ids: set[int],
    ) -> int | None:
        """Return the first active page with ``name`` and any of ``class_ids``."""
        rows = await node_repo.find_page_by_name(name)
        for row in rows:
            if class_ids and row.get("class_id") in class_ids:
                return row["id"]
            if not class_ids:
                return row["id"]
        return None

    async def upsert_page_by_external_id(
        self,
        workspace_id: int,
        user_id: int,
        external_id: str,
        *,
        external_id_property_id: int,
        name: str,
        class_ids: list[int] | None = None,
        property_values: dict[int, Any] | None = None,
        icon: str | None = None,
    ) -> Node:
        """Find or create a page mapped by an external identity property.

        The external id is stored on the page as ``external_id_property_id`` so
        that renames on either side do not break the mapping. If the page
        already exists, its name and property values are refreshed.
        """
        self._require("write_nodes")
        node_service = await self._get_node_service(workspace_id, user_id)
        node_repo = await self._get_node_repository(workspace_id, user_id)
        prop_service = await self._get_property_service(workspace_id, user_id)

        existing_id = await self._find_node_by_property_value(
            prop_service, external_id_property_id, external_id
        )

        if existing_id is None and class_ids:
            existing_id = await self._find_page_by_name_and_classes(
                node_repo, name, set(class_ids)
            )

        all_properties = {**(property_values or {})}
        all_properties[external_id_property_id] = external_id

        if existing_id is not None:
            await node_service.update_node(
                existing_id,
                NodeUpdateData(name=name, icon=icon),
                properties=all_properties,
            )
            node = await node_service.get_node_by_id(existing_id)
            if node is None:
                raise RuntimeError(f"Failed to reload mapped page {existing_id}")
            return node

        return await self.create_page(
            workspace_id,
            user_id,
            name,
            additional_classes=class_ids,
            property_values=all_properties,
            icon=icon,
        )

    def get_registered_routers(self) -> list[RouterRegistration]:
        """Return router registrations for this plugin (convenience)."""
        reg = self.registry.get_router_registration(self.plugin_id)
        return [reg] if reg else []
