"""Library plugin REST API: add-by-identifier (ISBN/DOI lookup) — Task 13.

Mounted at ``/api/plugins/notees.library``. Two endpoints:

- ``POST /lookup`` — resolve an ISBN or DOI against the external provider
  (Crossref / Open Library) and return normalized metadata for preview.
  Nothing is created at this stage.
- ``POST /sources`` — create the source node from the confirmed metadata
  (title is user-editable between lookup and confirm).

Provider failures surface as explicit errors (404 not found, 502 provider
unreachable) and never leave a partial node behind: creation only starts
after a successful lookup, and the create endpoint performs no network I/O.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.dependencies import get_current_user, require_write_scope
from app.logging_config import get_logger
from app.models import User
from app.plugins.core.context import PluginContext

from .dependencies import RequestContext, get_request_context
from .lookup import (
    InvalidIdentifierError,
    MetadataNotFoundError,
    MetadataProviderUnavailableError,
    SourceMetadata,
    classify_identifier,
    provider_for_kind,
)
from .pipeline import SOURCE_CLASS_NAMES, create_source_from_metadata

logger = get_logger(__name__)

router = APIRouter()


class PluginRuntime:
    """Holds the plugin's context after setup(); the router reaches it here."""

    context: PluginContext | None = None


runtime = PluginRuntime()


def _context() -> PluginContext:
    if runtime.context is None:
        raise HTTPException(status_code=503, detail="Library plugin not initialized")
    return runtime.context


class LookupRequest(BaseModel):
    """Raw pasted identifier (DOI, doi.org URL, or ISBN with/without hyphens)."""

    identifier: str = Field(min_length=1)


class CreatorPayload(BaseModel):
    """Normalized creator: a person (given/family) or an organization."""

    given_name: str = ""
    family_name: str = ""
    organization_name: str = ""


class CreateSourceRequest(BaseModel):
    """Confirmed metadata for source creation (post-preview, user-edited)."""

    title: str = Field(min_length=1)
    class_name: str = "document"
    creators: list[CreatorPayload] = Field(default_factory=list)
    publication_date: str | None = None
    publisher: str | None = None
    isbn: str | None = None
    doi: str | None = None


def _metadata_response(metadata: SourceMetadata) -> dict:
    return {
        "metadata": {
            "title": metadata.title,
            "creators": metadata.creators,
            "publication_date": metadata.publication_date,
            "publisher": metadata.publisher,
            "isbn": metadata.isbn,
            "doi": metadata.doi,
            "class_name": metadata.class_name,
            "language": metadata.language,
            "provider": metadata.provider,
        }
    }


@router.post("/lookup")
async def lookup_identifier(
    body: LookupRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """Resolve an ISBN/DOI to normalized metadata. Creates nothing."""
    del user  # authentication only; the lookup itself is workspace-independent
    try:
        kind, value = classify_identifier(body.identifier)
    except InvalidIdentifierError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    provider = provider_for_kind(kind)
    try:
        metadata = await provider.lookup(value)
    except MetadataNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except MetadataProviderUnavailableError as exc:
        logger.warning("Metadata provider %s failed: %s", provider.id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return _metadata_response(metadata)


@router.post("/sources", dependencies=[Depends(require_write_scope)])
async def create_source(
    body: CreateSourceRequest,
    ctx: RequestContext = Depends(get_request_context),
) -> dict:
    """Create a fully populated source node from confirmed metadata."""
    if body.class_name not in SOURCE_CLASS_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown source class: {body.class_name!r}",
        )
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title must not be empty")

    creators = [{k: v for k, v in creator.model_dump().items() if v} for creator in body.creators]
    metadata = SourceMetadata(
        title=title,
        creators=creators,
        publication_date=body.publication_date,
        publisher=body.publisher,
        isbn=body.isbn,
        doi=body.doi,
        class_name=body.class_name,
    )
    return await create_source_from_metadata(
        _context(),
        workspace_uuid=ctx.workspace_uuid,
        actor_uuid=ctx.user_uuid,
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        metadata=metadata,
    )
