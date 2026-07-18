"""Tests for asset file operations and lifecycle with content-addressed storage."""

import hashlib
import shutil

import pytest

from app.features.assets.service import AssetFileService

pytestmark = pytest.mark.unit


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
