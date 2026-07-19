"""Logseq importer plugin REST API."""

from __future__ import annotations

from fastapi import APIRouter, UploadFile

from .parser import count_md_blocks, parse_logseq_zip

router = APIRouter()


@router.post("/preview")
async def preview_logseq_zip(file: UploadFile) -> dict[str, object]:
    """Preview a Logseq ZIP without importing.

    Returns counts of pages, journals, blocks, wiki-links, and assets.
    """
    content = await file.read()
    try:
        parsed = parse_logseq_zip(content)
    except ValueError as exc:
        return {"error": str(exc)}

    block_count = sum(
        count_md_blocks(page.blocks) for page in parsed.pages + parsed.journals
    )
    return {
        "filename": file.filename,
        "pages": len(parsed.pages),
        "journals": len(parsed.journals),
        "blocks": block_count,
        "wiki_links": len(parsed.all_links),
        "assets": parsed.asset_count,
    }
