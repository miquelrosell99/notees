"""Shared asset helpers.

These utilities are used by both the API layer (``app.routers.assets``) and the
domain service layer (``app.domain.services.asset_service``). Keeping them in a
neutral utility module prevents domain → router imports and circular
dependencies.
"""

import uuid
from pathlib import Path

from app.db.connection import get_workspace_assets_dir

# Allowed file types and their extensions
ALLOWED_CONTENT_TYPES = {
    # Images
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    # Audio
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/webm": ".webm",
    # Documents (books, papers, comics, office docs)
    "application/pdf": ".pdf",
    "application/epub+zip": ".epub",
    "application/vnd.comicbook+zip": ".cbz",
    "application/x-cbz": ".cbz",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.oasis.opendocument.text": ".odt",
}

# MIME types treated as documents. Documents get a larger size allowance than
# media and fall back to the "file" asset category.
DOCUMENT_CONTENT_TYPES = {
    "application/pdf",
    "application/epub+zip",
    "application/vnd.comicbook+zip",
    "application/x-cbz",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.oasis.opendocument.text",
}

# Asset categories for frontend rendering
ASSET_CATEGORIES = {
    "image": ["image/jpeg", "image/png", "image/webp"],
    "audio": [
        "audio/mpeg",
        "audio/mp3",
        "audio/wav",
        "audio/wave",
        "audio/x-wav",
        "audio/ogg",
        "audio/opus",
        "audio/webm",
    ],
}

# Max file size: 50MB (images and audio)
MAX_FILE_SIZE = 50 * 1024 * 1024

# Max file size for documents: 100MB (scanned PDFs, large EPUBs)
MAX_DOCUMENT_FILE_SIZE = 100 * 1024 * 1024


def get_max_file_size(content_type: str) -> int:
    """Return the maximum allowed upload size in bytes for a content type."""
    if content_type in DOCUMENT_CONTENT_TYPES:
        return MAX_DOCUMENT_FILE_SIZE
    return MAX_FILE_SIZE

# Magic byte signatures: map expected MIME types → list of (offset, bytes) signatures.
# We check the file header rather than trusting the client-supplied Content-Type.
_MAGIC_SIGNATURES: dict[str, list[tuple[int, bytes]]] = {
    "image/jpeg": [(0, b"\xff\xd8\xff")],
    "image/png": [(0, b"\x89PNG\r\n\x1a\n")],
    "image/webp": [(0, b"RIFF"), (8, b"WEBP")],
    "audio/mpeg": [(0, b"ID3"), (0, b"\xff\xfb"), (0, b"\xff\xf3"), (0, b"\xff\xf2")],
    "audio/mp3": [(0, b"ID3"), (0, b"\xff\xfb"), (0, b"\xff\xf3"), (0, b"\xff\xf2")],
    "audio/wav": [(0, b"RIFF"), (8, b"WAVE")],
    "audio/wave": [(0, b"RIFF"), (8, b"WAVE")],
    "audio/x-wav": [(0, b"RIFF"), (8, b"WAVE")],
    "audio/ogg": [(0, b"OggS")],
    "audio/opus": [(0, b"OggS")],
    "audio/webm": [(0, b"\x1aE\xdf\xa3")],
    "application/pdf": [(0, b"%PDF-")],
    # EPUB is a ZIP whose first entry must be the uncompressed "mimetype" file
    # containing "application/epub+zip" (per the OCF spec), so bytes 30-58 are
    # fixed: filename at offset 30, content immediately after at offset 38.
    "application/epub+zip": [(30, b"mimetypeapplication/epub+zip")],
    # CBZ, DOCX and ODT are ZIP containers; magic bytes can only confirm ZIP.
    "application/vnd.comicbook+zip": [(0, b"PK\x03\x04")],
    "application/x-cbz": [(0, b"PK\x03\x04")],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [(0, b"PK\x03\x04")],
    "application/vnd.oasis.opendocument.text": [(0, b"PK\x03\x04")],
}


def check_magic_bytes(content: bytes, content_type: str) -> bool:
    """Verify that file content begins with the expected magic bytes.

    Returns True when the signature matches or when no signature is defined for
    the given MIME type (fail-open to avoid blocking legitimate edge cases).
    """
    sigs = _MAGIC_SIGNATURES.get(content_type)
    if not sigs:
        return True  # No signature registered → accept

    for sig_offset, sig_bytes in sigs:
        chunk = content[sig_offset : sig_offset + len(sig_bytes)]
        if chunk == sig_bytes:
            return True  # At least one matching signature found

    return False


def get_asset_category(content_type: str) -> str:
    """Get the asset category (image, audio, etc.) from content type."""
    for category, types in ASSET_CATEGORIES.items():
        if content_type in types:
            return category
    return "file"


def get_extension_from_content_type(content_type: str) -> str:
    """Get file extension from content type."""
    return ALLOWED_CONTENT_TYPES.get(content_type, "")


def validate_asset_uuid(asset_uuid: str) -> uuid.UUID:
    """Validate that ``asset_uuid`` is a well-formed UUID.

    Raises:
        ValueError: If the value is not a valid UUID.
    """
    try:
        return uuid.UUID(asset_uuid)
    except ValueError as exc:
        raise ValueError(f"Invalid asset UUID: {asset_uuid}") from exc


def get_asset_path(workspace_uuid: str, asset_uuid: str, extension: str) -> Path:
    """Get the legacy flat file path for an asset.

    Structure: workspaces/{workspace_uuid}/assets/{asset_uuid}/{asset_uuid}.{extension}
    """
    validate_asset_uuid(asset_uuid)
    assets_dir = get_workspace_assets_dir(workspace_uuid)
    asset_folder = assets_dir / asset_uuid
    asset_folder.mkdir(parents=True, exist_ok=True)
    target = asset_folder.resolve()
    if not target.is_relative_to(assets_dir.resolve()):
        raise ValueError(f"Asset path escapes assets directory: {asset_uuid}")
    return target / f"{asset_uuid}{extension}"
