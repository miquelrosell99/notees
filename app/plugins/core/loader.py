"""Plugin loader.

Discovers, validates, and executes backend plugin setup functions.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import TYPE_CHECKING

from app.logging_config import get_logger

from .exceptions import (
    PluginDependencyError,
    PluginManifestError,
)
from .manifest import PluginManifest

if TYPE_CHECKING:
    from .context import PluginContext
    from .registry import LoadedPlugin


logger = get_logger(__name__)


def _check_python_dependencies(dependencies: list[str]) -> None:
    """Import optional Python dependencies, raising PluginDependencyError on failure."""
    for dep in dependencies:
        # Strip version specifier to get package name.
        pkg_name = dep.split("=")[0].split(">")[0].split("<")[0].strip()
        if not pkg_name:
            continue
        try:
            importlib.import_module(pkg_name)
        except ImportError as exc:
            raise PluginDependencyError(
                pkg_name, f"Missing optional dependency '{dep}': {exc}"
            ) from exc


def _resolve_entrypoint(entrypoint: str) -> tuple[str, str]:
    """Split ``module.path:callable`` into module and callable names."""
    if ":" in entrypoint:
        module_name, attr_name = entrypoint.split(":", 1)
    elif "." in entrypoint:
        module_name, attr_name = entrypoint.rsplit(".", 1)
    else:
        raise PluginManifestError(
            entrypoint, f"Invalid entrypoint '{entrypoint}'; expected 'module.path:setup'"
        )
    return module_name, attr_name


class PluginLoader:
    """Scans plugin directories and loads enabled backend plugins."""

    def __init__(self, builtin_dir: Path, external_dir: Path) -> None:
        self.builtin_dir = builtin_dir
        self.external_dir = external_dir

    def discover(self) -> list[Path]:
        """Return all plugin directories containing a manifest.json."""
        candidates: list[Path] = []
        for base in (self.builtin_dir, self.external_dir):
            if not base.exists():
                continue
            for child in base.iterdir():
                manifest = child / "manifest.json"
                if child.is_dir() and manifest.exists():
                    candidates.append(child)
        return candidates

    def load_manifest(self, plugin_dir: Path) -> PluginManifest:
        """Load and validate a plugin manifest."""
        manifest_path = plugin_dir / "manifest.json"
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest = PluginManifest.model_validate(raw)
        except (json.JSONDecodeError, ValueError) as exc:
            raise PluginManifestError(
                plugin_dir.name, f"Invalid manifest.json: {exc}"
            ) from exc
        manifest.builtin = plugin_dir.parent.name == "builtin"
        # Builtins ship enabled unless they explicitly opt out with
        # "enabledByDefault": false (e.g. the Library plugin). External plugins
        # keep the manifest value (default: disabled).
        explicitly_disabled = isinstance(raw, dict) and (
            raw.get("enabledByDefault") is False or raw.get("enabled_by_default") is False
        )
        if manifest.builtin and not manifest.enabled_by_default and not explicitly_disabled:
            manifest.enabled_by_default = True
        return manifest

    def setup_plugin(
        self,
        plugin_dir: Path,
        manifest: PluginManifest,
        context: PluginContext,
        plugin: LoadedPlugin,
    ) -> None:
        """Run the backend setup entrypoint for a plugin.

        Setup is synchronous: plugins register routers, importers, exporters and
        side-effect handlers here. Any async work must happen at runtime via the
        registered callbacks.
        """
        entrypoint = manifest.backend.entrypoint
        if not entrypoint:
            return

        try:
            _check_python_dependencies(manifest.backend.dependencies)
        except PluginDependencyError as exc:
            plugin.backend_setup_failed = True
            plugin.backend_error = str(exc)
            logger.warning("Plugin %s disabled: %s", manifest.id, exc)
            return

        try:
            module_name, attr_name = _resolve_entrypoint(entrypoint)
            module = importlib.import_module(module_name)
            setup_fn = getattr(module, attr_name)
            result = setup_fn(context)
            if result is not None:
                logger.warning(
                    "Plugin %s setup returned a value; synchronous setup should not "
                    "return a coroutine.",
                    manifest.id,
                )
        except Exception as exc:  # noqa: BLE001
            plugin.backend_setup_failed = True
            plugin.backend_error = f"{type(exc).__name__}: {exc}"
            logger.exception("Plugin %s setup failed", manifest.id)
