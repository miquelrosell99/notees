"""Plugin system exceptions."""

from __future__ import annotations


class PluginError(Exception):
    """Base exception for plugin lifecycle errors."""

    def __init__(self, plugin_id: str, message: str) -> None:
        super().__init__(f"Plugin '{plugin_id}': {message}")
        self.plugin_id = plugin_id
        self.message = message


class PluginManifestError(PluginError):
    """Raised when a plugin manifest is invalid or missing required fields."""


class PluginDependencyError(PluginError):
    """Raised when a plugin declares a Python dependency that cannot be imported."""


class PluginPermissionError(PluginError):
    """Raised when a plugin attempts to register an extension point without permission."""


class PluginNotFoundError(PluginError):
    """Raised when a requested plugin is not installed or not enabled."""


class PluginInstallError(Exception):
    """Raised when a plugin installation from a remote source fails."""
