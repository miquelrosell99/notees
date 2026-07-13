"""HTTP routes for importing external formats."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import get_current_user, require_write_scope
from app.features.import_.dependencies import get_import_service
from app.features.import_.models import (
    MarkdownImportRequest,
    MarkdownImportResult,
)
from app.features.import_.service import ImportService
from app.models import User

router = APIRouter(
    prefix="/import",
    tags=["import"],
    dependencies=[Depends(get_current_user), Depends(require_write_scope)],
)


@router.post("/markdown", response_model=list[MarkdownImportResult])
async def import_markdown(
    request: MarkdownImportRequest,
    user: User = Depends(get_current_user),  # noqa: B008
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


def _node_title(name: str) -> str:
    """Return a plain-text title from a serialized AST name."""
    from app.domain.stringify_ast import StringifyMode, StringifyOptions, parse_ast, stringify_ast

    try:
        ast = parse_ast(name)
        return stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
    except Exception:
        return name
