"""Notees plugin system core."""

from __future__ import annotations

from .context import PluginContext
from .exceptions import (
    PluginDependencyError,
    PluginError,
    PluginManifestError,
    PluginNotFoundError,
    PluginPermissionError,
)
from .loader import PluginLoader
from .manager import PluginManager, plugin_manager
from .manifest import PluginManifest
from .ports import (
    ClassSideEffectContext,
    ExportContext,
    ExporterAdapter,
    ExportResult,
    ImportContext,
    ImporterAdapter,
    ImportResult,
    RouterRegistration,
    SettingSchema,
    SyncContext,
    SyncResult,
    SyncSource,
)
from .registry import LoadedPlugin, PluginRegistry

__all__ = [
    "ClassSideEffectContext",
    "ExportContext",
    "ExportResult",
    "ExporterAdapter",
    "ImportContext",
    "ImportResult",
    "ImporterAdapter",
    "LoadedPlugin",
    "PluginContext",
    "PluginDependencyError",
    "PluginError",
    "PluginLoader",
    "PluginManager",
    "PluginManifest",
    "PluginManifestError",
    "PluginNotFoundError",
    "PluginPermissionError",
    "PluginRegistry",
    "RouterRegistration",
    "SettingSchema",
    "SyncContext",
    "SyncResult",
    "SyncSource",
    "plugin_manager",
]
