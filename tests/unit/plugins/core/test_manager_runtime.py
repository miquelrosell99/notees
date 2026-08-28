"""Tests for runtime plugin lifecycle: restartless enable/disable, rescan, uninstall."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI

from app.config import settings
from app.plugins.core.manager import PluginManager

pytestmark = pytest.mark.unit

_SETUP_TEMPLATE = '''\
from fastapi import APIRouter


def setup(context):
    router = APIRouter()

    @router.get("/ping")
    def ping():
        return {{"pong": True}}

    context.register_router(router, prefix="")
'''


def _write_plugin(
    external: Path,
    folder: str,
    plugin_id: str,
    *,
    enabled_by_default: bool = False,
) -> Path:
    """Create a minimal on-disk plugin package with a router contribution."""
    plugin_dir = external / folder
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "manifest.json").write_text(
        json.dumps(
            {
                "id": plugin_id,
                "name": f"Test Plugin {folder}",
                "version": "1.0.0",
                "permissions": ["router"],
                "backend": {"entrypoint": f"{folder}.setup:setup"},
                "enabledByDefault": enabled_by_default,
            }
        ),
        encoding="utf-8",
    )
    (plugin_dir / "setup.py").write_text(_SETUP_TEMPLATE, encoding="utf-8")
    return plugin_dir


def _has_route(app: FastAPI, plugin_id: str) -> bool:
    expected = f"/api/plugins/{plugin_id}/ping"
    return any(getattr(route, "path", None) == expected for route in app.routes)


@pytest.fixture
def manager_env(monkeypatch, tmp_path):
    """A PluginManager bound to a fresh FastAPI app with isolated plugin dirs."""
    monkeypatch.setattr(settings, "database_dir", tmp_path)
    manager = PluginManager()
    # Redirect the builtin dir so the real builtin plugins are not discovered.
    builtin = tmp_path / "builtin"
    builtin.mkdir()
    manager.builtin_dir = builtin
    manager.loader.builtin_dir = builtin
    external = tmp_path / "plugins"
    app = FastAPI()
    manager.bind_app(app)
    module_names: list[str] = []
    yield manager, app, external, module_names
    for name in module_names:
        for key in list(sys.modules.keys()):
            if key == name or key.startswith(f"{name}."):
                del sys.modules[key]


def test_restartless_enable_disable_enable(manager_env) -> None:
    manager, app, external, modules = manager_env
    folder = "wp_lifecycle"
    modules.append(folder)
    plugin_dir = _write_plugin(external, folder, "notees.wp_lifecycle")

    plugin = manager.load_plugin_dir(plugin_dir, enabled=False)
    assert plugin.enabled is False
    assert not _has_route(app, "notees.wp_lifecycle")

    assert manager.set_enabled("notees.wp_lifecycle", True)
    assert plugin.enabled is True
    assert _has_route(app, "notees.wp_lifecycle")

    assert manager.set_enabled("notees.wp_lifecycle", False)
    assert plugin.enabled is False
    assert not _has_route(app, "notees.wp_lifecycle")
    assert manager.registry.get_router_registration("notees.wp_lifecycle") is None

    assert manager.set_enabled("notees.wp_lifecycle", True)
    assert plugin.enabled is True
    assert _has_route(app, "notees.wp_lifecycle")


def test_set_enabled_is_idempotent(manager_env) -> None:
    manager, app, external, modules = manager_env
    folder = "wp_idempotent"
    modules.append(folder)
    plugin_dir = _write_plugin(external, folder, "notees.wp_idempotent")
    manager.load_plugin_dir(plugin_dir, enabled=False)

    assert manager.set_enabled("notees.wp_idempotent", False) is True
    assert manager.set_enabled("notees.wp_idempotent", True) is True
    assert manager.set_enabled("notees.wp_idempotent", True) is True
    # Router mounted exactly once despite repeated enable calls.
    matches = [
        r
        for r in app.routes
        if getattr(r, "path", None) == "/api/plugins/notees.wp_idempotent/ping"
    ]
    assert len(matches) == 1


def test_set_enabled_unknown_plugin(manager_env) -> None:
    manager, _app, _external, _modules = manager_env
    assert manager.set_enabled("notees.missing", True) is False


def test_rescan_detects_dropped_folder(manager_env) -> None:
    manager, app, external, modules = manager_env
    assert manager.rescan() == []

    modules.append("wp_dropped")
    _write_plugin(external, "wp_dropped", "notees.wp_dropped")
    added = manager.rescan()
    assert [p.manifest.id for p in added] == ["notees.wp_dropped"]
    # Disabled by default: registered and listed, but no routes mounted.
    plugin = manager.get_plugin("notees.wp_dropped")
    assert plugin is not None
    assert plugin.enabled is False
    assert not _has_route(app, "notees.wp_dropped")

    # A second rescan finds nothing new and respects the current state.
    assert manager.rescan() == []
    assert manager.get_plugin("notees.wp_dropped") is not None


def test_rescan_loads_enabled_by_default(manager_env) -> None:
    manager, app, external, modules = manager_env
    modules.append("wp_auto")
    _write_plugin(external, "wp_auto", "notees.wp_auto", enabled_by_default=True)
    added = manager.rescan()
    assert [p.manifest.id for p in added] == ["notees.wp_auto"]
    assert _has_route(app, "notees.wp_auto")


def test_rescan_skips_invalid_folder(manager_env) -> None:
    manager, _app, external, _modules = manager_env
    bad_dir = external / "wp_broken"
    bad_dir.mkdir(parents=True)
    (bad_dir / "manifest.json").write_text("not json", encoding="utf-8")
    assert manager.rescan() == []
    assert manager.get_plugin("wp_broken") is None


def test_uninstall_removes_folder(manager_env) -> None:
    manager, app, external, modules = manager_env
    folder = "wp_uninstall"
    modules.append(folder)
    plugin_dir = _write_plugin(external, folder, "notees.wp_uninstall")
    manager.load_plugin_dir(plugin_dir, enabled=True)
    assert _has_route(app, "notees.wp_uninstall")

    assert manager.uninstall_plugin("notees.wp_uninstall") is True
    assert not plugin_dir.exists()
    assert manager.get_plugin("notees.wp_uninstall") is None
    assert not _has_route(app, "notees.wp_uninstall")
    # Idempotent on a missing plugin.
    assert manager.uninstall_plugin("notees.wp_uninstall") is False
