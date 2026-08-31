"""Backend plugin extension registries.

A registry holds the runtime contributions from all loaded plugins. It does not
know about plugin lifecycle; it only stores and retrieves registered items.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from fastapi import APIRouter

from app.core.derived.class_side_effects import (
    clear as clear_core_class_side_effects,
)
from app.core.derived.class_side_effects import (
    get as get_core_class_side_effects,
)
from app.core.derived.class_side_effects import (
    register as register_core_class_side_effect,
)
from app.core.derived.op_listeners import (
    unregister as unregister_core_op_listener,
)

from .ports import RouterRegistration

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from app.core.derived.op_listeners import OperationListener

    from .export import ExportProvider
    from .manifest import PluginManifest
    from .metadata import AssetMetadataHandler
    from .ports import (
        ClassSideEffectHandler,
        ExporterAdapter,
        ImporterAdapter,
        SettingSchema,
        SyncSource,
    )

    StartupHook = Callable[[], Awaitable[None]]


@dataclass
class LoadedPlugin:
    """Runtime representation of a loaded plugin."""

    manifest: PluginManifest
    path: str
    enabled: bool = False
    backend_setup_failed: bool = False
    backend_error: str | None = None
    frontend_setup_failed: bool = False
    frontend_error: str | None = None


class PluginRegistry:
    """Central registry for plugin runtime contributions."""

    def __init__(self) -> None:
        self._plugins: dict[str, LoadedPlugin] = {}
        self._routers: dict[str, RouterRegistration] = {}
        self._importers: dict[str, tuple[str, ImporterAdapter]] = {}
        self._exporters: dict[str, tuple[str, ExporterAdapter]] = {}
        self._sync_sources: dict[str, tuple[str, SyncSource]] = {}
        self._settings: dict[str, SettingSchema] = {}
        self._class_side_effects: dict[str, list[ClassSideEffectHandler]] = {}
        self._asset_metadata_handlers: dict[str, tuple[str, AssetMetadataHandler]] = {}
        self._export_providers: dict[str, tuple[str, ExportProvider]] = {}
        self._startup_hooks: dict[str, list[StartupHook]] = {}
        self._op_listeners: dict[str, list[OperationListener]] = {}

    # Plugins
    def add_plugin(self, plugin: LoadedPlugin) -> None:
        self._plugins[plugin.manifest.id] = plugin

    def get_plugin(self, plugin_id: str) -> LoadedPlugin | None:
        return self._plugins.get(plugin_id)

    def remove_plugin(self, plugin_id: str) -> LoadedPlugin | None:
        return self._plugins.pop(plugin_id, None)

    def list_plugins(self) -> list[LoadedPlugin]:
        return list(self._plugins.values())

    def set_enabled(self, plugin_id: str, enabled: bool) -> None:
        plugin = self._plugins.get(plugin_id)
        if plugin:
            plugin.enabled = enabled

    # Routers
    def add_router(self, plugin_id: str, router: APIRouter, prefix: str) -> None:
        self._routers[plugin_id] = RouterRegistration(
            plugin_id=plugin_id, router=router, prefix=prefix
        )

    def get_router(self, plugin_id: str) -> APIRouter | None:
        reg = self._routers.get(plugin_id)
        return reg.router if reg else None

    def get_router_registration(self, plugin_id: str) -> RouterRegistration | None:
        return self._routers.get(plugin_id)

    def remove_router(self, plugin_id: str) -> RouterRegistration | None:
        return self._routers.pop(plugin_id, None)

    def iter_routers(self):
        return self._routers.values()

    # Importers
    def add_importer(self, plugin_id: str, adapter: ImporterAdapter) -> None:
        self._importers[adapter.id] = (plugin_id, adapter)

    def get_importer(self, importer_id: str) -> tuple[str, ImporterAdapter] | None:
        return self._importers.get(importer_id)

    def list_importers(self) -> list[ImporterAdapter]:
        return [adapter for (_, adapter) in self._importers.values()]

    def remove_importers(self, plugin_id: str) -> list[ImporterAdapter]:
        removed: list[ImporterAdapter] = []
        for key in list(self._importers.keys()):
            pid, adapter = self._importers[key]
            if pid == plugin_id:
                removed.append(adapter)
                del self._importers[key]
        return removed

    # Exporters
    def add_exporter(self, plugin_id: str, adapter: ExporterAdapter) -> None:
        self._exporters[adapter.format_id] = (plugin_id, adapter)

    def get_exporter(self, format_id: str) -> ExporterAdapter | None:
        entry = self._exporters.get(format_id)
        return entry[1] if entry else None

    def get_exporter_registration(
        self, format_id: str
    ) -> tuple[str, ExporterAdapter] | None:
        return self._exporters.get(format_id)

    def list_exporters(self) -> list[ExporterAdapter]:
        return [adapter for (_, adapter) in self._exporters.values()]

    def remove_exporters(self, plugin_id: str) -> list[ExporterAdapter]:
        removed: list[ExporterAdapter] = []
        for key in list(self._exporters.keys()):
            pid, adapter = self._exporters[key]
            if pid == plugin_id:
                removed.append(adapter)
                del self._exporters[key]
        return removed

    # Sync sources
    def add_sync_source(self, plugin_id: str, source: SyncSource) -> None:
        self._sync_sources[source.id] = (plugin_id, source)

    def get_sync_source(self, source_id: str) -> SyncSource | None:
        entry = self._sync_sources.get(source_id)
        return entry[1] if entry else None

    def list_sync_sources(self) -> list[SyncSource]:
        return [source for (_, source) in self._sync_sources.values()]

    def remove_sync_sources(self, plugin_id: str) -> list[SyncSource]:
        removed: list[SyncSource] = []
        for key in list(self._sync_sources.keys()):
            pid, source = self._sync_sources[key]
            if pid == plugin_id:
                removed.append(source)
                del self._sync_sources[key]
        return removed

    # Settings
    def add_setting(self, plugin_id: str, schema: SettingSchema) -> None:
        self._settings[f"{plugin_id}.{schema.id}"] = schema

    def get_setting(self, key: str) -> SettingSchema | None:
        return self._settings.get(key)

    def list_settings(self) -> list[SettingSchema]:
        return list(self._settings.values())

    def remove_settings(self, plugin_id: str) -> list[SettingSchema]:
        prefix = f"{plugin_id}."
        removed: list[SettingSchema] = []
        for key in list(self._settings.keys()):
            if key.startswith(prefix):
                removed.append(self._settings.pop(key))
        return removed

    # Asset metadata handlers (Decision 30), keyed by MIME type
    def add_asset_metadata_handler(
        self, plugin_id: str, handler: AssetMetadataHandler
    ) -> None:
        for mime_type in handler.mime_types:
            self._asset_metadata_handlers[mime_type] = (plugin_id, handler)

    def get_asset_metadata_handler(
        self, mime_type: str
    ) -> tuple[str, AssetMetadataHandler] | None:
        return self._asset_metadata_handlers.get(mime_type)

    def list_asset_metadata_handlers(self) -> list[AssetMetadataHandler]:
        seen: dict[int, AssetMetadataHandler] = {}
        for _, handler in self._asset_metadata_handlers.values():
            seen[id(handler)] = handler
        return list(seen.values())

    def remove_asset_metadata_handlers(
        self, plugin_id: str
    ) -> list[AssetMetadataHandler]:
        removed: dict[int, AssetMetadataHandler] = {}
        for key in list(self._asset_metadata_handlers.keys()):
            pid, handler = self._asset_metadata_handlers[key]
            if pid == plugin_id:
                removed[id(handler)] = handler
                del self._asset_metadata_handlers[key]
        return list(removed.values())

    # Export providers (Decision 31/34), keyed by provider id
    def add_export_provider(self, plugin_id: str, provider: ExportProvider) -> None:
        self._export_providers[provider.id] = (plugin_id, provider)

    def get_export_provider(self, provider_id: str) -> ExportProvider | None:
        entry = self._export_providers.get(provider_id)
        return entry[1] if entry else None

    def list_export_providers(self) -> list[ExportProvider]:
        return [provider for (_, provider) in self._export_providers.values()]

    def remove_export_providers(self, plugin_id: str) -> list[ExportProvider]:
        removed: list[ExportProvider] = []
        for key in list(self._export_providers.keys()):
            pid, provider = self._export_providers[key]
            if pid == plugin_id:
                removed.append(provider)
                del self._export_providers[key]
        return removed

    # Startup hooks, invoked once after plugin load / enablement
    def add_startup_hook(self, plugin_id: str, hook: StartupHook) -> None:
        self._startup_hooks.setdefault(plugin_id, []).append(hook)

    def list_startup_hooks(self, plugin_id: str | None = None) -> list[StartupHook]:
        if plugin_id is not None:
            return list(self._startup_hooks.get(plugin_id, []))
        return [hook for hooks in self._startup_hooks.values() for hook in hooks]

    def remove_startup_hooks(self, plugin_id: str) -> None:
        self._startup_hooks.pop(plugin_id, None)

    # Post-commit operation listeners (Decision 13 continuous reconciliation)
    def add_op_listener(self, plugin_id: str, listener: OperationListener) -> None:
        self._op_listeners.setdefault(plugin_id, []).append(listener)

    def remove_op_listeners(self, plugin_id: str) -> None:
        for listener in self._op_listeners.pop(plugin_id, []):
            unregister_core_op_listener(listener)

    # Class side effects
    def add_class_side_effect(
        self, class_uuid: str, handler: ClassSideEffectHandler
    ) -> None:
        self._class_side_effects.setdefault(class_uuid, []).append(handler)

    def get_class_side_effects(self, class_uuid: str) -> list[ClassSideEffectHandler]:
        return list(self._class_side_effects.get(class_uuid, []))

    def remove_class_side_effects(self, plugin_id: str) -> None:
        for handlers in self._class_side_effects.values():
            handlers[:] = [
                h for h in handlers if getattr(h, "_plugin_id", None) != plugin_id
            ]

        for class_uuid in list(self._class_side_effects.keys()):
            core_handlers = get_core_class_side_effects(class_uuid)
            filtered = [
                h for h in core_handlers if getattr(h, "_plugin_id", None) != plugin_id
            ]
            if len(filtered) != len(core_handlers):
                clear_core_class_side_effects(class_uuid)
                for handler in filtered:
                    register_core_class_side_effect(class_uuid, handler)
