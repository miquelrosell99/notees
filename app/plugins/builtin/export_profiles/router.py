"""Export Profiles plugin REST API.

Mounted at ``/api/plugins/notees.export_profiles``. Profiles are stored as
JSON in workspace settings; runs go through the continuous-reconciliation
service so manual "export now" and the post-commit hook share one path.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.core.uuid import uuidv7
from app.dependencies import require_read_or_write_scope, require_write_scope
from app.logging_config import get_logger
from app.plugins.core.context import PluginContext

from .continuous import ExportContinuousService
from .dependencies import RequestContext, get_request_context
from .engine.materializer import CopyMaterializer
from .engine.runner import export_profile_zip
from .paths import EXPORT_ROOT_SETTING_KEY, profile_destination_root
from .profiles import (
    PROFILES_SETTING_KEY,
    ProfileValidationError,
    validate_profile,
)
from .services import WorkspaceExportServices
from .state import STATE_SETTING_KEY, get_profile_state, remove_profile_state

logger = get_logger(__name__)

router = APIRouter()


class PluginRuntime:
    """Holds the plugin's context and continuous service after setup()."""

    context: PluginContext | None = None
    continuous: ExportContinuousService | None = None


runtime = PluginRuntime()


def _context() -> PluginContext:
    if runtime.context is None:
        raise HTTPException(status_code=503, detail="Export profiles plugin not initialized")
    return runtime.context


def _continuous() -> ExportContinuousService:
    if runtime.continuous is None:
        raise HTTPException(status_code=503, detail="Export profiles plugin not initialized")
    return runtime.continuous


async def _load_profiles(ctx: RequestContext) -> list[dict[str, Any]]:
    context = _context()
    raw = await context.get_setting(
        ctx.workspace_id, ctx.user_id, PROFILES_SETTING_KEY, []
    )
    return list(raw) if isinstance(raw, list) else []


async def _save_profiles(ctx: RequestContext, profiles: list[dict[str, Any]]) -> None:
    context = _context()
    await context.set_setting(ctx.workspace_id, ctx.user_id, PROFILES_SETTING_KEY, profiles)


class ProfilePayload(BaseModel):
    """Profile fields accepted by create/update (id may be omitted on create)."""

    id: str | None = None
    name: str
    enabled: bool = True
    provider: str = "bibliographic"
    query: dict[str, Any]
    destination: str = ""
    materializer: str = "copy"
    reconciliation_policy: str = "sync"
    provider_config: dict[str, Any] = Field(default_factory=dict)


class SettingsPayload(BaseModel):
    export_root: str | None = None


@router.get("/profiles", dependencies=[Depends(require_read_or_write_scope)])
async def list_profiles(ctx: RequestContext = Depends(get_request_context)):
    """List profiles with their last-run status for the current user."""
    context = _context()
    profiles = await _load_profiles(ctx)
    state = await context.get_setting(ctx.workspace_id, ctx.user_id, STATE_SETTING_KEY, {})
    items = []
    for raw in profiles:
        try:
            profile = validate_profile(raw)
        except ProfileValidationError:
            continue
        run_state = get_profile_state(state if isinstance(state, dict) else {}, ctx.user_uuid, profile.id)
        items.append(
            {
                **profile.to_dict(),
                "slug": profile.slug,
                "last_run": run_state.last_run,
                "report": run_state.report or None,
            }
        )
    return {"profiles": items}


@router.post("/profiles", dependencies=[Depends(require_write_scope)], status_code=201)
async def create_profile(
    payload: ProfilePayload,
    ctx: RequestContext = Depends(get_request_context),
):
    """Create a profile; runs once immediately for the current user."""
    data = payload.model_dump()
    data["id"] = payload.id or uuidv7()
    try:
        profile = validate_profile(data)
    except ProfileValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    profiles = await _load_profiles(ctx)
    if any(p.get("id") == profile.id for p in profiles):
        raise HTTPException(status_code=409, detail="Profile id already exists")
    profiles.append(profile.to_dict())
    await _save_profiles(ctx, profiles)
    continuous = _continuous()
    reports = await continuous.reconcile_for_user(
        ctx.workspace_uuid,
        ctx.user_uuid,
        only_profile_id=profile.id,
        include_disabled=True,
    )
    return {
        "profile": {**profile.to_dict(), "slug": profile.slug},
        "reports": [report.to_dict() for report in reports],
    }


@router.put("/profiles/{profile_id}", dependencies=[Depends(require_write_scope)])
async def update_profile(
    profile_id: str,
    payload: ProfilePayload,
    ctx: RequestContext = Depends(get_request_context),
):
    """Replace a profile; reconciles immediately so renames/moves propagate."""
    profiles = await _load_profiles(ctx)
    index = next((i for i, p in enumerate(profiles) if p.get("id") == profile_id), None)
    if index is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    data = payload.model_dump()
    data["id"] = profile_id
    try:
        profile = validate_profile(data)
    except ProfileValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    profiles[index] = profile.to_dict()
    await _save_profiles(ctx, profiles)
    continuous = _continuous()
    reports = await continuous.reconcile_for_user(
        ctx.workspace_uuid,
        ctx.user_uuid,
        only_profile_id=profile.id,
        include_disabled=True,
    )
    return {
        "profile": {**profile.to_dict(), "slug": profile.slug},
        "reports": [report.to_dict() for report in reports],
    }


@router.delete("/profiles/{profile_id}", dependencies=[Depends(require_write_scope)])
async def delete_profile(
    profile_id: str,
    ctx: RequestContext = Depends(get_request_context),
):
    """Delete a profile and its engine-managed files (foreign files stay)."""
    context = _context()
    profiles = await _load_profiles(ctx)
    remaining = [p for p in profiles if p.get("id") != profile_id]
    if len(remaining) == len(profiles):
        raise HTTPException(status_code=404, detail="Profile not found")

    state = await context.get_setting(ctx.workspace_id, ctx.user_id, STATE_SETTING_KEY, {})
    if isinstance(state, dict):
        removed = next((p for p in profiles if p.get("id") == profile_id), None)
        if removed is not None:
            await _delete_managed_files(ctx, removed, state)
        state = remove_profile_state(state, profile_id)
        await context.set_setting(ctx.workspace_id, ctx.user_id, STATE_SETTING_KEY, state)

    await _save_profiles(ctx, remaining)
    return {"deleted": profile_id}


async def _delete_managed_files(
    ctx: RequestContext, profile_data: dict[str, Any], state: dict[str, Any]
) -> None:
    """Remove a deleted profile's managed files for every recorded user."""
    context = _context()
    custom_root = await context.get_setting(
        ctx.workspace_id, ctx.user_id, EXPORT_ROOT_SETTING_KEY, None
    )
    try:
        from .profiles import ExportProfile

        profile = ExportProfile.from_dict(profile_data)
    except Exception:  # noqa: BLE001
        return
    for user_uuid, user_state in state.items():
        if not isinstance(user_state, dict) or profile.id not in user_state:
            continue
        run_state = get_profile_state(state, user_uuid, profile.id)
        try:
            root = profile_destination_root(
                custom_root, user_uuid, profile.slug, profile.destination
            )
        except ValueError:
            continue
        materializer = CopyMaterializer(root)
        for path in sorted(run_state.managed):
            materializer.remove(path)
        materializer.prune_empty_dirs()


@router.post("/profiles/{profile_id}/run", dependencies=[Depends(require_write_scope)])
async def run_profile(
    profile_id: str,
    ctx: RequestContext = Depends(get_request_context),
):
    """Manual "export now": reconcile one profile for the current user."""
    profiles = await _load_profiles(ctx)
    if not any(p.get("id") == profile_id for p in profiles):
        raise HTTPException(status_code=404, detail="Profile not found")
    continuous = _continuous()
    reports = await continuous.reconcile_for_user(
        ctx.workspace_uuid,
        ctx.user_uuid,
        only_profile_id=profile_id,
        include_disabled=True,
    )
    return {"reports": [report.to_dict() for report in reports]}


@router.get("/profiles/{profile_id}/zip", dependencies=[Depends(require_read_or_write_scope)])
async def export_zip(
    profile_id: str,
    ctx: RequestContext = Depends(get_request_context),
):
    """Manual "export ZIP": the same resolution, streamed as an archive."""
    context = _context()
    profiles = await _load_profiles(ctx)
    raw = next((p for p in profiles if p.get("id") == profile_id), None)
    if raw is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    try:
        profile = validate_profile(raw)
    except ProfileValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    factory = context.get_port("WorkspaceStore")
    store = await factory(ctx.workspace_uuid, ctx.user_uuid)
    try:
        services = WorkspaceExportServices(store)
        data, report = await export_profile_zip(
            profile, services, context.registry.get_export_provider
        )
    finally:
        await store.close()

    headers = {
        "Content-Disposition": f'attachment; filename="{profile.slug}.zip"',
        "X-Export-Files": str(len(report.created)),
        "X-Export-Skipped": str(len(report.skipped)),
    }
    return Response(content=data, media_type="application/zip", headers=headers)


@router.get("/options/classes", dependencies=[Depends(require_read_or_write_scope)])
async def list_classes(ctx: RequestContext = Depends(get_request_context)):
    """List active classes (class-picker preset compiles to a class AST)."""
    context = _context()
    factory = context.get_port("WorkspaceStore")
    store = await factory(ctx.workspace_uuid, ctx.user_uuid)
    try:
        await store.sync()
        rows = await store.query(
            "SELECT id, name FROM class WHERE active = 1 ORDER BY name"
        )
    finally:
        await store.close()
    from app.domain.entities.constants import SYSTEM_CLASS_UUIDS

    system_uuids = set(SYSTEM_CLASS_UUIDS.values())
    return {
        "classes": [
            {"id": row["id"], "name": row["name"], "is_system": row["id"] in system_uuids}
            for row in rows
        ]
    }


@router.get("/options/collections", dependencies=[Depends(require_read_or_write_scope)])
async def list_collections(ctx: RequestContext = Depends(get_request_context)):
    """List collection nodes (collection-picker preset compiles to an AST)."""
    from app.domain.entities.constants import SYSTEM_CLASS_UUIDS

    collection_uuid = SYSTEM_CLASS_UUIDS["collection"]
    context = _context()
    factory = context.get_port("WorkspaceStore")
    store = await factory(ctx.workspace_uuid, ctx.user_uuid)
    try:
        await store.sync()
        rows = await store.query(
            """
            SELECT n.id, n.content FROM node n
            WHERE n.active = 1
              AND EXISTS (SELECT 1 FROM json_each(n.class_ids)
                          WHERE value IN (SELECT class_id FROM class_hierarchy
                                          WHERE ancestor_id = ?))
            ORDER BY n.created_at
            """,
            (collection_uuid,),
        )
    finally:
        await store.close()
    from .services import _content_to_title

    return {
        "collections": [
            {"id": row["id"], "name": _content_to_title(row["content"]) or row["id"]}
            for row in rows
        ]
    }


@router.get("/settings", dependencies=[Depends(require_read_or_write_scope)])
async def get_settings(ctx: RequestContext = Depends(get_request_context)):
    """Return plugin settings (custom export root)."""
    context = _context()
    export_root = await context.get_setting(
        ctx.workspace_id, ctx.user_id, EXPORT_ROOT_SETTING_KEY, None
    )
    return {"export_root": export_root}


@router.put("/settings", dependencies=[Depends(require_write_scope)])
async def put_settings(
    payload: SettingsPayload,
    ctx: RequestContext = Depends(get_request_context),
):
    """Set the custom export root (empty/null restores the default)."""
    context = _context()
    export_root = payload.export_root.strip() if payload.export_root else None
    await context.set_setting(
        ctx.workspace_id, ctx.user_id, EXPORT_ROOT_SETTING_KEY, export_root
    )
    return {"export_root": export_root}
