"""EPUB plugin REST API: per-attachment extract/inject actions.

Mounted at ``/api/plugins/notees.epub`` (the plugin registers it with an empty
prefix). Both actions run over an asset id; the target source is either passed
explicitly or resolved as the unique source whose ``attachments`` property
references the asset.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import require_write_scope
from app.features.assets.metadata.service import (
    AssetMetadataNotSupportedError,
    AssetMetadataService,
)
from app.features.assets.service import AssetMissingError
from app.logging_config import get_logger
from app.plugins.core.metadata import AssetMetadataError

from .dependencies import get_asset_metadata_service

router = APIRouter()
logger = get_logger(__name__)


class EpubActionRequest(BaseModel):
    """Optional explicit source; otherwise resolved via the attachments property."""

    source_uuid: str | None = None


async def _resolve_source_uuid(service: AssetMetadataService, asset_uuid: str, source_uuid: str | None) -> str:
    if source_uuid is not None:
        return source_uuid
    sources = await service.find_referencing_sources(asset_uuid)
    if not sources:
        raise HTTPException(
            status_code=422,
            detail="Asset is not attached to any source; pass source_uuid explicitly",
        )
    if len(sources) > 1:
        raise HTTPException(
            status_code=409,
            detail="Asset is attached to multiple sources; pass source_uuid explicitly",
        )
    return sources[0]


@router.post(
    "/assets/{asset_uuid}/extract",
    dependencies=[Depends(require_write_scope)],
)
async def extract_metadata_to_source(
    asset_uuid: str,
    body: EpubActionRequest | None = None,
    service: AssetMetadataService = Depends(get_asset_metadata_service),
):
    """Extract EPUB metadata and apply it to the source node."""
    try:
        resolved = await _resolve_source_uuid(service, asset_uuid, body.source_uuid if body else None)
        return await service.apply_extract_to_source(asset_uuid, resolved)
    except AssetMissingError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except AssetMetadataNotSupportedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except AssetMetadataError as exc:
        logger.warning("EPUB metadata extraction failed for %s: %s", asset_uuid, exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post(
    "/assets/{asset_uuid}/inject",
    dependencies=[Depends(require_write_scope)],
)
async def inject_source_metadata(
    asset_uuid: str,
    body: EpubActionRequest | None = None,
    service: AssetMetadataService = Depends(get_asset_metadata_service),
):
    """Write the source node's metadata (title/authors/cover/…) into the EPUB."""
    try:
        resolved = await _resolve_source_uuid(service, asset_uuid, body.source_uuid if body else None)
        return await service.inject_from_source(asset_uuid, resolved)
    except AssetMissingError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except AssetMetadataNotSupportedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except AssetMetadataError as exc:
        logger.warning("EPUB metadata injection failed for %s: %s", asset_uuid, exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
