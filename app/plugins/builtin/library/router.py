"""Library plugin REST API: add-by-identifier and add-by-file (Tasks 13/14).

Mounted at ``/api/plugins/notees.library``. Endpoints:

- ``POST /lookup`` — resolve an ISBN or DOI against the external provider
  (Crossref / Open Library) and return normalized metadata for preview.
  Nothing is created at this stage.
- ``POST /sources`` — create the source node from the confirmed metadata
  (title is user-editable between lookup and confirm).
- ``POST /pdf/inspect`` — accept a PDF upload, extract identifiers (DOI from
  XMP metadata / info dict / first-pages text, ISBN from text, title hints)
  and, when one is found, resolve it via the Task 13 providers. Creates
  nothing. Provider failures surface as explicit 404/502 errors.
- ``POST /sources/from-pdf`` — create the source from the confirmed metadata
  and attach the uploaded PDF as a ``role=representation`` asset.

Provider failures surface as explicit errors and never leave a partial node
behind: network I/O only happens in ``/lookup`` and ``/pdf/inspect`` (which
persist nothing), while the create endpoints perform no network I/O at all.
``/sources/from-pdf`` is all-or-nothing: if the asset upload or attachment
linking fails after the source node was created, both are rolled back
(best-effort delete) so no half-populated source remains.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.dependencies import get_current_user, require_write_scope
from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS
from app.features.assets.dependencies import get_asset_service, get_workspace_store
from app.features.assets.service import AssetService
from app.features.assets.utils import check_magic_bytes, get_max_file_size
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
from .pdf import PdfExtractionError, extract_pdf_identifiers
from .pipeline import SOURCE_CLASS_NAMES, create_source_from_metadata

logger = get_logger(__name__)

router = APIRouter()

# System `role` selection option UUID for "representation" (see
# SYSTEM_PROPERTY_SCHEMA_SPECS in app/domain/entities/constants.py).
ROLE_REPRESENTATION_OPTION_UUID = "00000000-0000-0000-0004-000000000001"

PDF_CONTENT_TYPE = "application/pdf"


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


# ---------------------------------------------------------------------------
# Task 14 — add-by-file (PDF lookup)
# ---------------------------------------------------------------------------


async def _read_pdf_upload(file: UploadFile) -> bytes:
    """Read and validate an uploaded PDF (size + magic bytes)."""
    data = await file.read()
    max_size = get_max_file_size(PDF_CONTENT_TYPE)
    if len(data) > max_size:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {max_size // (1024 * 1024)}MB",
        )
    if not check_magic_bytes(data, PDF_CONTENT_TYPE):
        raise HTTPException(status_code=400, detail="The selected file is not a PDF")
    return data


@router.post("/pdf/inspect")
async def inspect_pdf(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
) -> dict:
    """Extract identifiers from a PDF and resolve them. Creates nothing.

    Returns the extracted identifiers, a title suggestion (XMP/info-dict
    title, prominent first-page line, or the filename), and — when a DOI or
    ISBN was found — the provider-resolved metadata for preview. A readable
    PDF without identifiers returns ``metadata: null`` so the client can
    offer the filename-based fallback; an unreadable PDF is a 400.
    """
    del user  # authentication only; extraction/resolution is workspace-independent
    data = await _read_pdf_upload(file)
    filename = file.filename or "document.pdf"

    try:
        identifiers = extract_pdf_identifiers(data)
    except PdfExtractionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    suggested_title = identifiers.title_hint or _filename_title(filename)
    response: dict = {
        "filename": filename,
        "identifiers": {
            "doi": identifiers.doi,
            "isbn": identifiers.isbn,
            "title_hint": identifiers.title_hint,
        },
        "suggested_title": suggested_title,
        "metadata": None,
    }

    found = identifiers.identifier
    if found is None:
        return response

    kind, value = found
    provider = provider_for_kind(kind)
    try:
        metadata = await provider.lookup(value)
    except MetadataNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except MetadataProviderUnavailableError as exc:
        logger.warning("Metadata provider %s failed for PDF identifier: %s", provider.id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    response["metadata"] = _metadata_response(metadata)["metadata"]
    return response


def _filename_title(filename: str) -> str:
    """Human-ish title from a filename: strip extension, tidy separators."""
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    title = stem.replace("_", " ").replace("-", " ").strip()
    return title or filename


def _parse_creators(raw: str) -> list[dict[str, str]]:
    """Parse the JSON creators form field; drop empty/invalid entries."""
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid creators payload") from exc
    if not isinstance(payload, list):
        raise HTTPException(status_code=400, detail="Invalid creators payload")
    creators: list[dict[str, str]] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        creator = {k: str(v) for k, v in entry.items() if k in ("given_name", "family_name", "organization_name") and v}
        if creator:
            creators.append(creator)
    return creators


@router.post("/sources/from-pdf", dependencies=[Depends(require_write_scope)])
async def create_source_from_pdf(
    ctx: RequestContext = Depends(get_request_context),
    store: WorkspaceStore = Depends(get_workspace_store),
    asset_service: AssetService = Depends(get_asset_service),
    file: UploadFile = File(...),
    title: str = Form(...),
    class_name: str = Form("document"),
    creators: str = Form("[]"),
    publication_date: str | None = Form(None),
    publisher: str | None = Form(None),
    isbn: str | None = Form(None),
    doi: str | None = Form(None),
    attach: bool = Form(True),
) -> dict:
    """Create a source from confirmed metadata and attach the PDF to it.

    Performs no network I/O — the metadata was resolved (or accepted as a
    filename fallback) by ``/pdf/inspect`` and confirmed by the user. When
    ``attach`` is true the PDF is uploaded as an asset node with
    ``role=representation`` and appended to the source's ``attachments``.

    All-or-nothing: if attaching fails after the source was created, the
    source node and the uploaded asset are deleted again (best effort), so a
    retry never meets a half-populated source.
    """
    if class_name not in SOURCE_CLASS_NAMES:
        raise HTTPException(status_code=400, detail=f"Unknown source class: {class_name!r}")
    title = title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title must not be empty")

    data = await _read_pdf_upload(file)
    filename = file.filename or "document.pdf"

    metadata = SourceMetadata(
        title=title,
        creators=_parse_creators(creators),
        publication_date=publication_date or None,
        publisher=publisher or None,
        isbn=isbn or None,
        doi=doi or None,
        class_name=class_name,
    )
    result = await create_source_from_metadata(
        _context(),
        workspace_uuid=ctx.workspace_uuid,
        actor_uuid=ctx.user_uuid,
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        metadata=metadata,
    )
    node_uuid = str(result["node_uuid"])

    asset_uuid: str | None = None
    if attach:
        try:
            asset = await asset_service.upload_asset(
                file_bytes=data,
                filename=filename,
                content_type=PDF_CONTENT_TYPE,
            )
            asset_uuid = str(asset["uuid"])
            await store.set_property(
                property_value_id=uuidv7(),
                node_id=asset_uuid,
                schema_id=SYSTEM_PROPERTY_UUIDS["role"],
                value=ROLE_REPRESENTATION_OPTION_UUID,
            )
            await store.set_property(
                property_value_id=uuidv7(),
                node_id=node_uuid,
                schema_id=SYSTEM_PROPERTY_UUIDS["attachments"],
                value=asset_uuid,
            )
            await store.sync()
        except Exception as exc:
            logger.error("PDF attach failed for source %s: %s", node_uuid, exc, exc_info=True)
            # Roll back: no half-populated source left behind.
            if asset_uuid is not None:
                try:
                    await asset_service.delete_asset(asset_uuid)
                except Exception:
                    logger.warning("Rollback: could not delete asset %s", asset_uuid)
            try:
                # Pull the pipeline's ops first so this store's derived state
                # knows the source node before deleting it.
                await store.sync()
                await store.delete_node(node_uuid)
                await store.sync()
            except Exception:
                logger.warning("Rollback: could not delete source %s", node_uuid)
            raise HTTPException(status_code=500, detail="Could not attach the PDF. Nothing was created.") from exc

    return {
        "node_uuid": node_uuid,
        "citekey": result["citekey"],
        "asset_uuid": asset_uuid,
        "needs_metadata": metadata.doi is None and metadata.isbn is None,
    }
