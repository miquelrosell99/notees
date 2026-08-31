"""Tests for asset file operations and lifecycle with content-addressed storage."""

import hashlib
import shutil

import pytest

from app.features.assets.service import AssetFileService
from app.features.assets.utils import (
    MAX_DOCUMENT_FILE_SIZE,
    MAX_FILE_SIZE,
    check_magic_bytes,
    get_extension_from_content_type,
    get_max_file_size,
)

pytestmark = pytest.mark.unit


def _minimal_epub_bytes() -> bytes:
    """Build a byte stream with a valid EPUB (OCF) header layout.

    A real EPUB stores the uncompressed "mimetype" entry first: the 30-byte
    ZIP local file header is followed by the filename "mimetype" at offset 30
    and the content "application/epub+zip" at offset 38.
    """
    return (
        b"PK\x03\x04"
        + b"\x14\x00\x00\x00\x08\x00"  # version, flags, method
        + b"\x00" * 16  # timestamps, crc, sizes
        + b"\x08\x00\x00\x00"  # filename length 8, extra length 0
        + b"mimetype"
        + b"application/epub+zip"
        + b"\x00" * 64
    )


@pytest.fixture
def asset_file_service(tmp_path):
    """Return an AssetFileService using a temporary assets directory."""
    service = AssetFileService("test-workspace", tmp_path)
    try:
        yield service
    finally:
        if tmp_path.exists():
            shutil.rmtree(tmp_path)


@pytest.mark.asyncio
async def test_asset_file_deduplication(asset_file_service):
    """Uploading the same bytes twice reuses the same content file."""
    content = b"duplicate me"
    hash1, ext1, path1 = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="a.jpg",
        content_type="image/jpeg",
    )
    hash2, ext2, path2 = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="b.jpg",
        content_type="image/jpeg",
    )
    assert hash1 == hash2
    assert ext1 == ext2 == ".jpg"
    assert path1 == path2
    assert path1.exists()


@pytest.mark.asyncio
async def test_asset_file_deletes_when_unref_count_zero(asset_file_service):
    """Deleting the last reference removes the content file."""
    content = b"test image content"
    file_hash, _ext, source_path = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="test.jpg",
        content_type="image/jpeg",
    )
    assert source_path.exists()

    deleted = await asset_file_service.delete_asset(file_hash)
    assert deleted is True
    assert not source_path.exists()


@pytest.mark.asyncio
async def test_asset_file_deletion_keeps_file_with_refs(asset_file_service):
    """Deleting one reference keeps the file when others remain."""
    content = b"shared content"
    file_hash, _ext, source_path = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="x.png",
        content_type="image/png",
    )
    # Simulate a second reference by incrementing the count.
    asset_file_service._increment_ref(file_hash, ".png")

    deleted = await asset_file_service.delete_asset(file_hash)
    assert deleted is False
    assert source_path.exists()


@pytest.mark.asyncio
async def test_asset_file_storage_path_is_content_addressed(asset_file_service):
    """Files are stored under assets/<hash prefix>/<hash>."""
    content = b"hello world"
    _file_hash, _ext, source_path = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="doc.png",
        content_type="image/png",
    )
    parts = source_path.relative_to(asset_file_service.assets_dir).parts
    expected_hash = hashlib.sha256(content).hexdigest()
    assert parts[0] == expected_hash[:4]
    assert parts[1] == f"{expected_hash}.png"


class TestDocumentContentTypes:
    """Document MIME types are mapped to extensions and limits."""

    @pytest.mark.parametrize(
        ("content_type", "extension"),
        [
            ("application/pdf", ".pdf"),
            ("application/epub+zip", ".epub"),
            ("application/vnd.comicbook+zip", ".cbz"),
            ("application/x-cbz", ".cbz"),
            ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
            ("application/vnd.oasis.opendocument.text", ".odt"),
        ],
    )
    def test_document_extension_mapping(self, content_type, extension):
        assert get_extension_from_content_type(content_type) == extension

    @pytest.mark.parametrize(
        "content_type",
        [
            "application/pdf",
            "application/epub+zip",
            "application/vnd.comicbook+zip",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.oasis.opendocument.text",
        ],
    )
    def test_documents_use_document_size_limit(self, content_type):
        assert get_max_file_size(content_type) == MAX_DOCUMENT_FILE_SIZE

    @pytest.mark.parametrize("content_type", ["image/png", "audio/mpeg"])
    def test_media_keeps_default_size_limit(self, content_type):
        assert get_max_file_size(content_type) == MAX_FILE_SIZE


class TestDocumentMagicBytes:
    """Magic-byte validation for document formats."""

    def test_pdf_signature_accepted(self):
        assert check_magic_bytes(b"%PDF-1.7\n...", "application/pdf") is True

    def test_pdf_signature_rejects_non_pdf(self):
        assert check_magic_bytes(b"not a pdf at all", "application/pdf") is False

    def test_epub_signature_accepted(self):
        assert check_magic_bytes(_minimal_epub_bytes(), "application/epub+zip") is True

    def test_epub_rejects_renamed_text_file(self):
        # A .txt renamed to .epub must fail: no ZIP header, no mimetype entry.
        assert check_magic_bytes(b"plain text content", "application/epub+zip") is False

    def test_epub_rejects_generic_zip(self):
        # A ZIP without the OCF mimetype entry is not an EPUB.
        generic_zip = b"PK\x03\x04" + b"\x00" * 100
        assert check_magic_bytes(generic_zip, "application/epub+zip") is False

    @pytest.mark.parametrize(
        "content_type",
        [
            "application/vnd.comicbook+zip",
            "application/x-cbz",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.oasis.opendocument.text",
        ],
    )
    def test_zip_container_signature(self, content_type):
        assert check_magic_bytes(b"PK\x03\x04" + b"\x00" * 64, content_type) is True
        assert check_magic_bytes(b"plain text content", content_type) is False
