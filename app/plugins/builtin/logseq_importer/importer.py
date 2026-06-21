"""Logseq folder importer adapter."""

from __future__ import annotations

import io
import zipfile

from app.plugins.core.ports import (
    ImportContext,
    ImporterAdapter,
    ImportResult,
)


class LogseqFolderImporter(ImporterAdapter):
    """Import a ZIP of Logseq markdown files."""

    id = "logseq.folder"
    label = "Logseq markdown folder"
    file_extensions = ["zip"]

    async def import_data(
        self,
        payload: bytes,
        _content_type: str | None,
        context: ImportContext,
    ) -> ImportResult:
        result = ImportResult()
        try:
            zf = zipfile.ZipFile(io.BytesIO(payload))
        except zipfile.BadZipFile:
            result.messages.append("Uploaded file is not a valid ZIP archive")
            return result

        md_files = [n for n in zf.namelist() if n.endswith(".md")]
        result.messages.append(f"Found {len(md_files)} markdown files in archive")

        # TODO: parse markdown files and create Notees nodes via NodeService.
        return result
