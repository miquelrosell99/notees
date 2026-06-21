"""Logseq importer plugin REST API."""

from __future__ import annotations

from fastapi import APIRouter, UploadFile

router = APIRouter()


@router.post("/preview")
async def preview_logseq_zip(file: UploadFile):
    """Preview a Logseq ZIP without importing."""
    return {"filename": file.filename, "size": len(await file.read())}
