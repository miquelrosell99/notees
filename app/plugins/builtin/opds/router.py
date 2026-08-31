"""OPDS plugin REST API: catalog feeds, downloads, and settings.

Mounted at ``/api/plugins/notees.opds``. Feed and download endpoints accept
HTTP Basic auth (OPDS clients) or the standard session mechanisms; the
settings endpoints are for the web UI and use the standard session auth.

Downloads never expose internal storage paths: the download endpoint mints a
short-lived asset token and redirects to the existing asset download flow.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel

from app.core.workspace_store import WorkspaceStore
from app.dependencies import require_read_or_write_scope, require_write_scope
from app.features.assets.router import create_asset_token
from app.logging_config import get_logger
from app.plugins.builtin.export_profiles.dependencies import (
    RequestContext,
    get_request_context,
)
from app.plugins.builtin.export_profiles.services import (
    QueryResolutionError,
    WorkspaceExportServices,
)
from app.plugins.core.context import PluginContext

from .dependencies import get_opds_request_context
from .feed import (
    ACQ_MEDIA_TYPE,
    NAV_MEDIA_TYPE,
    build_acquisition_feed,
    build_root_feed,
    class_feed_path,
)
from .selection import CatalogBuilder, CatalogEntry, default_query

logger = get_logger(__name__)

router = APIRouter()

CATALOG_SETTING_KEY = "catalog"


class PluginRuntime:
    """Holds the plugin's context after setup()."""

    context: PluginContext | None = None


runtime = PluginRuntime()


def _context() -> PluginContext:
    if runtime.context is None:
        raise HTTPException(status_code=503, detail="OPDS plugin not initialized")
    return runtime.context


def _feed_base(request: Request) -> str:
    """Absolute base of this plugin's API, derived from the request."""
    return f"{str(request.base_url).rstrip('/')}/api/plugins/notees.opds"


def _feed_id_prefix(workspace_uuid: str) -> str:
    return f"urn:notees:opds:{workspace_uuid}"


class CatalogSelection(BaseModel):
    """Catalog selection config stored in workspace settings."""

    saved_query_id: str | None = None


async def _load_selection(ctx: RequestContext) -> CatalogSelection:
    raw = await _context().get_setting(ctx.workspace_id, ctx.user_id, CATALOG_SETTING_KEY, {})
    if not isinstance(raw, dict):
        return CatalogSelection()
    saved_query_id = raw.get("saved_query_id")
    return CatalogSelection(saved_query_id=str(saved_query_id) if saved_query_id else None)


def _query_for(selection: CatalogSelection) -> dict[str, Any]:
    """Map the catalog selection to the export-profiles query shape."""
    if selection.saved_query_id:
        return {"saved_query_id": selection.saved_query_id}
    return default_query()


async def _resolve_entries(ctx: RequestContext) -> tuple[list[CatalogEntry], WorkspaceStore]:
    """Resolve the catalog for the current user; caller must close the store."""
    context = _context()
    selection = await _load_selection(ctx)
    factory = context.get_port("WorkspaceStore")
    store: WorkspaceStore = await factory(ctx.workspace_uuid, ctx.user_uuid)
    try:
        entries = await CatalogBuilder(store).entries_for_query(_query_for(selection))
    except QueryResolutionError as exc:
        await store.close()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return entries, store


@router.get("/opds")
async def root_feed(
    request: Request,
    ctx: RequestContext = Depends(get_opds_request_context),
):
    """Root navigation feed: All publications plus one entry per class."""
    entries, store = await _resolve_entries(ctx)
    try:
        xml = build_root_feed(_feed_base(request), _feed_id_prefix(ctx.workspace_uuid), entries)
    finally:
        await store.close()
    return Response(content=xml, media_type=NAV_MEDIA_TYPE)


@router.get("/opds/all")
async def all_publications_feed(
    request: Request,
    ctx: RequestContext = Depends(get_opds_request_context),
):
    """Acquisition feed with every publication in the catalog."""
    entries, store = await _resolve_entries(ctx)
    try:
        xml = build_acquisition_feed(
            _feed_base(request),
            f"{_feed_id_prefix(ctx.workspace_uuid)}:all",
            "All publications",
            entries,
            "/opds/all",
        )
    finally:
        await store.close()
    return Response(content=xml, media_type=ACQ_MEDIA_TYPE)


@router.get("/opds/class/{class_name}")
async def class_feed(
    class_name: str,
    request: Request,
    ctx: RequestContext = Depends(get_opds_request_context),
):
    """Acquisition feed for one class (matched on the most specific class)."""
    entries, store = await _resolve_entries(ctx)
    try:
        filtered = [
            entry
            for entry in entries
            if (entry.primary_class or "").lower() == class_name.lower()
        ]
        xml = build_acquisition_feed(
            _feed_base(request),
            f"{_feed_id_prefix(ctx.workspace_uuid)}:class:{class_name.lower()}",
            class_name.replace("-", " ").title(),
            filtered,
            class_feed_path(class_name),
        )
    finally:
        await store.close()
    return Response(content=xml, media_type=ACQ_MEDIA_TYPE)


@router.get("/opds/download/{asset_uuid}")
async def download_asset(
    request: Request,
    asset_uuid: str,
    ctx: RequestContext = Depends(get_opds_request_context),
):
    """Redirect to the canonical asset download with a fresh short-lived token.

    Keeps acquisition/cover downloads on the existing asset token/download
    flow (range support included) without ever exposing internal paths.
    """
    context = _context()
    factory = context.get_port("WorkspaceStore")
    store: WorkspaceStore = await factory(ctx.workspace_uuid, ctx.user_uuid)
    try:
        metadata = await WorkspaceExportServices(store).get_asset_metadata(asset_uuid)
    finally:
        await store.close()
    if metadata is None:
        raise HTTPException(status_code=404, detail="Asset not found")

    token, _ = create_asset_token(asset_uuid, str(ctx.user.id))
    base = str(request.base_url).rstrip("/")
    return RedirectResponse(
        url=f"{base}/api/assets/{asset_uuid}?asset_token={token}",
        status_code=307,
    )


@router.get("/info", dependencies=[Depends(require_read_or_write_scope)])
async def catalog_info(
    request: Request,
    ctx: RequestContext = Depends(get_request_context),
):
    """Catalog summary for the settings tab: feed URL, selection, contents."""
    entries, store = await _resolve_entries(ctx)
    try:
        selection = await _load_selection(ctx)
        counts: dict[str, int] = {}
        for entry in entries:
            primary = entry.primary_class
            if primary is not None:
                counts[primary] = counts.get(primary, 0) + 1
        feed_path = f"{str(request.base_url).rstrip('/')}/api/plugins/notees.opds/opds"
        return {
            "feed_url": feed_path,
            "selection": (
                {"kind": "saved_query", "saved_query_id": selection.saved_query_id}
                if selection.saved_query_id
                else {"kind": "all_sources"}
            ),
            "workspace_uuid": ctx.workspace_uuid,
            "publication_count": len(entries),
            "classes": [
                {"name": name, "count": counts[name]} for name in sorted(counts)
            ],
        }
    finally:
        await store.close()


@router.get("/settings", dependencies=[Depends(require_read_or_write_scope)])
async def get_settings(ctx: RequestContext = Depends(get_request_context)):
    """Return the catalog selection config."""
    selection = await _load_selection(ctx)
    return selection.model_dump()


@router.put("/settings", dependencies=[Depends(require_write_scope)])
async def put_settings(
    payload: CatalogSelection,
    ctx: RequestContext = Depends(get_request_context),
):
    """Set the catalog selection (saved-query id, or null for all sources)."""
    saved_query_id = payload.saved_query_id.strip() if payload.saved_query_id else None
    await _context().set_setting(
        ctx.workspace_id,
        ctx.user_id,
        CATALOG_SETTING_KEY,
        {"saved_query_id": saved_query_id},
    )
    return {"saved_query_id": saved_query_id}
