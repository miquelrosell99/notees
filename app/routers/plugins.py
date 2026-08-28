"""Plugin system REST API."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel

from app.dependencies import (
    get_current_user,
    get_settings_repository,
    require_read_or_write_scope,
    require_write_scope,
)
from app.domain.repositories.interfaces import SettingsRepository
from app.features.auth.dependencies import require_admin
from app.features.workspaces.manager import get_active_workspace_id
from app.logging_config import get_logger
from app.models import User
from app.plugins.core import PluginContext, plugin_manager
from app.plugins.core.installer import (
    PluginInstallError,
    create_install_job,
    get_install_job,
    install_plugin_from_zip,
    run_install_job,
)
from app.plugins.core.ports import ImportContext, ImportResult
from app.utils import utc_now

logger = get_logger(__name__)
router = APIRouter(
    prefix="/plugins",
    tags=["plugins"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)


class InstallPluginRequest(BaseModel):
    url: str


class PluginSettingValueRequest(BaseModel):
    value: Any


async def _active_workspace_id(repo: SettingsRepository, user_id: int) -> int:
    """Resolve the current user's active workspace to an integer id."""
    active_uuid = get_active_workspace_id(str(user_id))
    if not active_uuid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No active workspace selected")
    workspace_id = await repo.get_workspace_id_by_uuid(active_uuid)
    if workspace_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Active workspace not found")
    return workspace_id


def _plugin_summary(plugin) -> dict[str, Any]:
    return {
        "id": plugin.manifest.id,
        "name": plugin.manifest.name,
        "version": plugin.manifest.version,
        "description": plugin.manifest.description,
        "author": plugin.manifest.author,
        "license": plugin.manifest.license,
        "builtin": plugin.manifest.builtin,
        "enabled": plugin.enabled,
        "permissions": plugin.manifest.permissions,
        "minAppVersion": plugin.manifest.min_app_version,
        "enabledByDefault": plugin.manifest.enabled_by_default,
        "backend": plugin.manifest.backend.model_dump(by_alias=True) if plugin.manifest.backend else None,
        "frontend": plugin.manifest.frontend.model_dump(by_alias=True) if plugin.manifest.frontend else None,
        "contributes": plugin.manifest.contributes.model_dump(by_alias=True),
        "backend_setup_failed": plugin.backend_setup_failed,
        "backend_error": plugin.backend_error,
        "frontend_setup_failed": plugin.frontend_setup_failed,
        "frontend_error": plugin.frontend_error,
    }


@router.get("", response_model=list[dict[str, Any]])
async def list_plugins(
    user: User = Depends(get_current_user),
):
    """List all installed plugins with their status."""
    return [_plugin_summary(p) for p in plugin_manager.list_plugins()]


@router.get("/info")
async def get_plugins_info(
    user: User = Depends(require_admin),
):
    """Return plugin storage locations (admin only; exposes server paths)."""
    return {
        "external_dir": str(plugin_manager.external_dir),
        "builtin_dir": str(plugin_manager.builtin_dir),
    }


@router.post("/rescan", dependencies=[Depends(require_admin), Depends(require_write_scope)])
async def rescan_plugins():
    """Re-run discovery over the plugin folders and load newly dropped plugins.

    Plugin folders placed manually into the external plugins directory are
    detected, validated, and loaded with their manifest's default enablement
    state. Folders already known to the registry are left untouched.
    """
    added = plugin_manager.rescan()
    return {
        "added": [p.manifest.id for p in added],
        "plugins": [_plugin_summary(p) for p in added],
    }


@router.post("/install/zip", dependencies=[Depends(require_admin), Depends(require_write_scope)])
async def install_plugin_zip(
    file: UploadFile,
    user: User = Depends(require_admin),
):
    """Install a plugin from an uploaded ZIP archive.

    The archive must contain exactly one top-level folder with a valid
    ``manifest.json``; it is extracted into the external plugins directory and
    loaded without a restart.
    """
    content = await file.read()
    try:
        result = install_plugin_from_zip(content)
    except PluginInstallError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return result


@router.get("/{plugin_id}")
async def get_plugin(
    plugin_id: str,
    user: User = Depends(get_current_user),
):
    """Return a single plugin manifest and status."""
    plugin = plugin_manager.get_plugin(plugin_id)
    if not plugin:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")
    return _plugin_summary(plugin)


@router.post("/{plugin_id}/enable", dependencies=[Depends(require_admin), Depends(require_write_scope)])
async def enable_plugin(
    plugin_id: str,
    user: User = Depends(get_current_user),
):
    """Enable a plugin, taking effect immediately (no restart)."""
    if not plugin_manager.set_enabled(plugin_id, True):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")
    return {"id": plugin_id, "enabled": True, "restart_required": False}


@router.post("/{plugin_id}/disable", dependencies=[Depends(require_admin), Depends(require_write_scope)])
async def disable_plugin(
    plugin_id: str,
    user: User = Depends(get_current_user),
):
    """Disable a plugin, taking effect immediately (no restart).

    Routes and registry contributions are removed; background work already
    spawned by the plugin is not forcibly cancelled.
    """
    if not plugin_manager.set_enabled(plugin_id, False):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")
    return {"id": plugin_id, "enabled": False, "restart_required": False}


@router.post("/install", status_code=status.HTTP_202_ACCEPTED)
async def install_plugin(
    request: InstallPluginRequest,
    user: User = Depends(require_admin),
):
    """Clone a plugin from a git URL and validate its manifest.

    Returns immediately with a job id; poll ``GET /plugins/install/jobs/{job_id}``
    for completion.
    """
    git_url = request.url.strip()
    if not git_url:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Git URL is required")

    job_id = create_install_job(git_url)
    asyncio.create_task(run_install_job(job_id, git_url))
    return {"job_id": job_id, "status": "pending"}


@router.get("/install/jobs/{job_id}")
async def get_install_job_endpoint(
    job_id: str,
    user: User = Depends(require_admin),
):
    """Return the status of a plugin install job."""
    job = get_install_job(job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    return job


@router.post("/{plugin_id}/load", dependencies=[Depends(require_admin)])
async def load_plugin(plugin_id: str):
    """Activate a plugin that is already installed but not loaded."""
    plugin = plugin_manager.get_plugin(plugin_id)
    if plugin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")
    loaded = plugin_manager.load_plugin_dir(Path(plugin.path), enabled=True)
    return _plugin_summary(loaded)


@router.post("/{plugin_id}/unload", dependencies=[Depends(require_admin)])
async def unload_plugin_endpoint(plugin_id: str):
    """Deactivate a loaded plugin without removing its files."""
    ok = plugin_manager.unload_plugin(plugin_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")
    return {"id": plugin_id, "loaded": False}


@router.post("/{plugin_id}/reload", dependencies=[Depends(require_admin)])
async def reload_plugin_endpoint(plugin_id: str):
    """Reload a plugin's code and re-register its contributions."""
    try:
        loaded = plugin_manager.reload_plugin(plugin_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return _plugin_summary(loaded)


@router.delete("/{plugin_id}", dependencies=[Depends(require_admin)])
async def uninstall_plugin(plugin_id: str):
    """Unload a plugin and delete its directory. Built-in plugins cannot be uninstalled."""
    plugin = plugin_manager.get_plugin(plugin_id)
    if plugin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")
    if plugin.manifest.builtin:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot uninstall built-in plugins")

    plugin_manager.uninstall_plugin(plugin_id)
    return {"id": plugin_id, "uninstalled": True}


@router.post("/{plugin_id}/update", dependencies=[Depends(require_admin)])
async def update_plugin(plugin_id: str):
    """Run ``git pull`` in the plugin directory and reload it."""
    plugin = plugin_manager.get_plugin(plugin_id)
    if plugin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")

    proc = await asyncio.create_subprocess_exec(
        "git", "-C", plugin.path, "pull",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip() or stdout.decode(errors="replace").strip()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"git pull failed: {detail}")

    try:
        loaded = plugin_manager.reload_plugin(plugin_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to reload plugin %s after update", plugin_id)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to reload plugin") from exc
    return _plugin_summary(loaded)


@router.get("/{plugin_id}/settings")
async def get_plugin_settings(
    plugin_id: str,
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Return a plugin's contributed settings schemas and current workspace values."""
    plugin = plugin_manager.get_plugin(plugin_id)
    if plugin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")

    workspace_id = await _active_workspace_id(repo, int(user.id))
    stored = await repo.get_workspace_settings(workspace_id)
    prefix = f"plugin:{plugin_id}:"
    values = {k.removeprefix(prefix): v for k, v in stored.items() if k.startswith(prefix)}

    return {
        "plugin_id": plugin_id,
        "settings": [
            {
                "id": s.id,
                "type": s.type,
                "label": s.label,
                "description": s.description,
                "default": s.default,
                "options": s.options,
                "required": s.required,
                "value": values.get(s.id, s.default),
            }
            for s in plugin.manifest.contributes.settings
        ],
    }


@router.put("/{plugin_id}/settings/{key}", dependencies=[Depends(require_write_scope)])
async def set_plugin_setting_endpoint(
    plugin_id: str,
    key: str,
    body: PluginSettingValueRequest,
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Update a single plugin setting in the active workspace."""
    plugin = plugin_manager.get_plugin(plugin_id)
    if plugin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")

    valid_keys = {s.id for s in plugin.manifest.contributes.settings}
    if key not in valid_keys:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown setting '{key}'")

    workspace_id = await _active_workspace_id(repo, int(user.id))
    await repo.set_workspace_setting(
        workspace_id,
        f"plugin:{plugin_id}:{key}",
        body.value,
        utc_now(),
        int(user.id),
    )
    return {"status": "ok"}


@router.get("/exporters/list")
async def list_exporters(
    user: User = Depends(get_current_user),
):
    """List registered exporter adapters."""
    return [
        {
            "id": adapter.format_id,
            "label": adapter.label,
            "extension": adapter.extension,
            "mime_type": adapter.mime_type,
        }
        for adapter in plugin_manager.registry.list_exporters()
    ]


@router.get("/importers/list")
async def list_importers(
    user: User = Depends(get_current_user),
):
    """List registered importer adapters."""
    return [
        {"id": imp.id, "label": imp.label, "file_extensions": imp.file_extensions}
        for imp in plugin_manager.registry.list_importers()
    ]


@router.post("/import/{importer_id}", dependencies=[Depends(require_write_scope)])
async def run_import(
    importer_id: str,
    file: UploadFile,
    workspace_uuid: str,
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Run a registered importer adapter against an uploaded file."""
    registered = plugin_manager.get_importer(importer_id)
    if registered is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Importer not found")

    plugin_id, adapter = registered
    plugin = plugin_manager.get_plugin(plugin_id)
    if plugin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin not found")

    workspace_id = await repo.get_workspace_id_by_uuid(workspace_uuid)
    if workspace_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")

    content = await file.read()
    plugin_context = PluginContext(
        plugin_id=plugin_id,
        permissions=set(plugin.manifest.permissions),
        registry=plugin_manager.registry,
        port_factories=plugin_manager.port_factories,
    )
    context = ImportContext(
        workspace_id=workspace_id,
        user_id=int(user.id),
        workspace_uuid=workspace_uuid,
        actor_uuid=user.uuid,
        plugin_context=plugin_context,
        filename=file.filename,
    )
    result: ImportResult = await adapter.import_data(
        content, file.content_type, context
    )
    return {
        "created_node_ids": result.created_node_ids,
        "updated_node_ids": result.updated_node_ids,
        "skipped_count": result.skipped_count,
        "error_count": result.error_count,
        "messages": result.messages,
    }


@router.get("/sync/sources")
async def list_sync_sources(
    user: User = Depends(get_current_user),
):
    """List registered sync sources."""
    return [
        {"id": source.id, "label": source.label}
        for source in plugin_manager.registry.list_sync_sources()
    ]
