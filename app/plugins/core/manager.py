"""PluginManager orchestrates plugin discovery, loading, and lifecycle."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from fastapi import FastAPI

from app.config import settings
from app.logging_config import get_logger

from .context import PluginContext, PortFactory
from .exceptions import PluginNotFoundError
from .loader import PluginLoader
from .registry import LoadedPlugin, PluginRegistry

logger = get_logger(__name__)


class PluginManager:
    """Singleton-ish manager for the plugin system.

    The manager is instantiated once and used during FastAPI lifespan to load
    plugins. It also exposes helper methods for mounting routers and executing
    extension points.
    """

    def __init__(self) -> None:
        self.builtin_dir = Path(__file__).parent.parent / "builtin"
        self.external_dir = settings.database_dir / "plugins"
        self.external_dir.mkdir(parents=True, exist_ok=True)
        self.loader = PluginLoader(self.builtin_dir, self.external_dir)
        self.registry = PluginRegistry()
        self.port_factories: dict[str, PortFactory] = {}
        self._loaded = False
        self._app: FastAPI | None = None
        self._route_lock = asyncio.Lock()

    def bind_app(self, app: FastAPI) -> None:
        """Store the FastAPI app so routers can be mounted at runtime."""
        self._app = app

    def register_port(self, name: str, factory: PortFactory) -> None:
        """Register a core domain-service factory available to plugins."""
        self.port_factories[name] = factory

    async def load_plugins(self) -> None:
        """Discover and load all backend plugins."""
        if self._loaded:
            return

        # Ensure external plugin directory is importable.
        if str(self.external_dir) not in sys.path:
            sys.path.insert(0, str(self.external_dir))

        plugin_dirs = self.loader.discover()
        for plugin_dir in sorted(plugin_dirs, key=lambda p: p.name):
            manifest = self.loader.load_manifest(plugin_dir)
            enabled = manifest.enabled_by_default

            plugin = LoadedPlugin(
                manifest=manifest,
                path=str(plugin_dir),
                enabled=enabled,
            )
            self.registry.add_plugin(plugin)

            if not enabled:
                continue

            context = PluginContext(
                plugin_id=manifest.id,
                permissions=set(manifest.permissions),
                registry=self.registry,
                port_factories=self.port_factories,
            )
            await self.loader.setup_plugin(plugin_dir, manifest, context, plugin)

        self._loaded = True

    async def load_plugin_dir(self, plugin_dir: Path, enabled: bool = True) -> LoadedPlugin:
        """Load a single plugin directory at runtime and mount its router if enabled."""
        manifest = self.loader.load_manifest(plugin_dir)

        parent = str(plugin_dir.parent)
        if parent not in sys.path:
            sys.path.insert(0, parent)

        plugin = LoadedPlugin(
            manifest=manifest,
            path=str(plugin_dir),
            enabled=enabled,
        )
        self.registry.add_plugin(plugin)

        if enabled:
            context = PluginContext(
                plugin_id=manifest.id,
                permissions=set(manifest.permissions),
                registry=self.registry,
                port_factories=self.port_factories,
            )
            await self.loader.setup_plugin(plugin_dir, manifest, context, plugin)
            await self._mount_plugin_router(manifest.id)

        return plugin

    async def unload_plugin(self, plugin_id: str) -> bool:
        """Disable a plugin, unregister its contributions, and unmount its routes."""
        plugin = self.registry.get_plugin(plugin_id)
        if plugin is None:
            return False

        # Remove imported modules so a future reload re-imports fresh code.
        plugin_path = Path(plugin.path)
        package_root = plugin_path.name
        for name in list(sys.modules.keys()):
            if name == package_root or name.startswith(f"{package_root}."):
                del sys.modules[name]

        self.registry.remove_router(plugin_id)
        self.registry.remove_importers(plugin_id)
        self.registry.remove_exporters(plugin_id)
        self.registry.remove_sync_sources(plugin_id)
        self.registry.remove_settings(plugin_id)
        self.registry.remove_class_side_effects(plugin_id)
        await self._unmount_plugin_router(plugin_id)

        plugin.enabled = False
        return True

    async def reload_plugin(self, plugin_id: str) -> LoadedPlugin:
        """Unload and re-load a single plugin directory."""
        plugin = self.registry.get_plugin(plugin_id)
        if plugin is None:
            raise PluginNotFoundError(plugin_id, "Plugin not found")

        plugin_path = Path(plugin.path)
        was_enabled = plugin.enabled
        await self.unload_plugin(plugin_id)
        self.registry.remove_plugin(plugin_id)
        return await self.load_plugin_dir(plugin_path, enabled=was_enabled)

    async def _mount_plugin_router(self, plugin_id: str) -> None:
        """Mount a plugin's router on the bound FastAPI app."""
        if self._app is None:
            return
        reg = self.registry.get_router_registration(plugin_id)
        if reg is None:
            return
        prefix = f"/api/plugins/{reg.plugin_id}"
        if reg.prefix:
            prefix = f"{prefix}/{reg.prefix}"
        async with self._route_lock:
            self._app.include_router(reg.router, prefix=prefix, tags=[reg.plugin_id])

    async def _unmount_plugin_router(self, plugin_id: str) -> None:
        """Remove a plugin's routes from the bound FastAPI app."""
        if self._app is None:
            return
        reg = self.registry.get_router_registration(plugin_id)
        if reg is None:
            return

        route_ids = {id(r) for r in reg.router.routes}
        async with self._route_lock:
            self._app.routes[:] = [
                r for r in self._app.routes if id(r) not in route_ids
            ]
            self._app.openapi_schema = None

    def mount_routers(self, app: FastAPI | None = None) -> None:
        """Mount all registered plugin routers under ``/api/plugins/<id>``.

        If no app is provided, the manager falls back to the bound app.
        """
        target = app or self._app
        if target is None:
            return
        for reg in self.registry.iter_routers():
            prefix = f"/api/plugins/{reg.plugin_id}"
            if reg.prefix:
                prefix = f"{prefix}/{reg.prefix}"
            target.include_router(reg.router, prefix=prefix, tags=[reg.plugin_id])

    def get_plugin(self, plugin_id: str) -> LoadedPlugin | None:
        return self.registry.get_plugin(plugin_id)

    def list_plugins(self) -> list[LoadedPlugin]:
        return self.registry.list_plugins()

    def set_enabled(self, plugin_id: str, enabled: bool) -> bool:
        """Enable or disable a plugin. Requires a restart to take effect."""
        plugin = self.registry.get_plugin(plugin_id)
        if plugin is None:
            return False
        plugin.enabled = enabled
        return True

    def get_importer(self, importer_id: str):
        return self.registry.get_importer(importer_id)

    def get_exporter(self, format_id: str):
        return self.registry.get_exporter(format_id)

    def get_exporter_registration(self, format_id: str):
        return self.registry.get_exporter_registration(format_id)

    def get_sync_source(self, source_id: str):
        return self.registry.get_sync_source(source_id)


# Global manager instance used by the application.
plugin_manager = PluginManager()
