"""HTTP routes for importing external formats."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.features.import_.dependencies import get_import_service
from app.features.import_.models import (
    MarkdownImportRequest,
    MarkdownImportResult,
    OpmlImportRequest,
)
from app.features.import_.service import ImportService

router = APIRouter(prefix="/import", tags=["import"])


@router.post("/markdown", response_model=list[MarkdownImportResult])
async def import_markdown(
    request: MarkdownImportRequest,
    import_service: ImportService = Depends(get_import_service),
) -> list[MarkdownImportResult]:
    """Import one or more Markdown documents as nodes."""
    results: list[MarkdownImportResult] = []
    for item in request.items:
        try:
            node, created = await import_service.import_markdown(
                content=item.content,
                parent_uuid=item.parent_uuid,
                sequence=item.sequence,
                uuid_conflict_mode=request.uuid_conflict_mode,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        results.append(
            MarkdownImportResult(
                node_uuid=str(node.uuid),
                title=_node_title(node.name),
                created=created,
                existing=not created,
            )
        )
    return results


@router.post("/opml", response_model=list[MarkdownImportResult])
async def import_opml(
    request: OpmlImportRequest,
    import_service: ImportService = Depends(get_import_service),
) -> list[MarkdownImportResult]:
    """Import an OPML outline as a tree of page nodes."""
    try:
        imported = await import_service.import_opml(
            content=request.content,
            parent_uuid=request.parent_uuid,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return [
        MarkdownImportResult(
            node_uuid=str(node.uuid),
            title=_node_title(node.name),
            created=created,
            existing=not created,
        )
        for node, created in imported
    ]


def _node_title(name: str) -> str:
    """Return a plain-text title from a serialized AST name."""
    from app.domain.stringify_ast import StringifyMode, StringifyOptions, parse_ast, stringify_ast

    try:
        ast = parse_ast(name)
        return stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
    except Exception:
        return name
