"""Tests for asset file operations and lifecycle with content-addressed storage."""
import shutil
from pathlib import Path
from typing import Any

import pytest

from app.features.assets.port import AssetRepository


class _FakeAssetRepository(AssetRepository):
    """In-memory stub for AssetRepository used in AssetFileService unit tests."""

    def __init__(self):
        self._files: dict[int, dict[str, Any]] = {}
        self._next_id = 1

    async def get_page_and_asset_class_ids(self, user_id: int) -> tuple[int, int]:
        return 1, 2

    async def convert_node_to_asset(
        self,
        node_id: int,
        asset_uuid: str,
        name: str,
        asset_class_id: int,
        user_id: int,
        asset_file_id: int | None = None,
    ) -> None:
        pass

    async def asset_exists_by_uuid(self, uuid: str) -> bool:
        return False

    async def create_asset_file(
        self,
        hash: str,
        size_bytes: int,
        extension: str,
        storage_path: str,
        user_id: int,
    ) -> int:
        file_id = self._next_id
        self._next_id += 1
        self._files[file_id] = {
            "id": file_id,
            "hash": hash,
            "size_bytes": size_bytes,
            "extension": extension,
            "storage_path": storage_path,
            "ref_count": 1,
        }
        return file_id

    async def find_asset_file_by_hash(self, hash: str) -> dict[str, Any] | None:
        for row in self._files.values():
            if row["hash"] == hash:
                return dict(row)
        return None

    async def get_asset_file_by_id(self, asset_file_id: int) -> dict[str, Any] | None:
        row = self._files.get(asset_file_id)
        return dict(row) if row else None

    async def increment_asset_file_ref_count(self, asset_file_id: int) -> None:
        if asset_file_id in self._files:
            self._files[asset_file_id]["ref_count"] += 1

    async def decrement_asset_file_ref_count(self, asset_file_id: int) -> int:
        if asset_file_id not in self._files:
            return 0
        self._files[asset_file_id]["ref_count"] -= 1
        return self._files[asset_file_id]["ref_count"]


@pytest.fixture
def asset_file_service(tmp_path):
    """Return an AssetFileService using a temporary assets directory."""
    from app.features.assets.service import AssetFileService

    service = AssetFileService(str(tmp_path), _FakeAssetRepository())
    original_dir = service.assets_dir
    service.assets_dir = tmp_path
    try:
        yield service
    finally:
        service.assets_dir = original_dir
        if tmp_path.exists():
            shutil.rmtree(tmp_path)


@pytest.mark.asyncio
async def test_asset_file_deduplication(asset_file_service):
    """Uploading the same bytes twice reuses the same content file."""
    content = b"duplicate me"
    id1, ext1, path1 = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="a.jpg",
        content_type="image/jpeg",
    )
    id2, ext2, path2 = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="b.jpg",
        content_type="image/jpeg",
    )
    assert id1 == id2
    assert ext1 == ext2 == ".jpg"
    assert path1 == path2
    assert path1.exists()


@pytest.mark.asyncio
async def test_asset_file_deletes_when_unref_count_zero(asset_file_service):
    """Deleting the last reference removes the content file."""
    content = b"test image content"
    file_id, _ext, source_path = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="test.jpg",
        content_type="image/jpeg",
    )
    assert source_path.exists()

    deleted = await asset_file_service.delete_asset(file_id)
    assert deleted is True
    assert not source_path.exists()


@pytest.mark.asyncio
async def test_asset_file_deletion_keeps_file_with_refs(asset_file_service):
    """Deleting one reference keeps the file when others remain."""
    content = b"shared content"
    file_id, _ext, source_path = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="x.png",
        content_type="image/png",
    )
    # Simulate a second reference by incrementing the count.
    await asset_file_service._asset_repo.increment_asset_file_ref_count(file_id)

    deleted = await asset_file_service.delete_asset(file_id)
    assert deleted is False
    assert source_path.exists()


@pytest.mark.asyncio
async def test_asset_file_storage_path_is_content_addressed(asset_file_service):
    """Files are stored under assets/files/<hash prefix>/<hash>."""
    content = b"hello world"
    _file_id, _ext, source_path = await asset_file_service.create_asset(
        file_bytes=content,
        original_filename="doc.txt",
        content_type="text/plain",
    )
    parts = source_path.relative_to(asset_file_service.assets_dir).parts
    assert parts[0] == "files"
    assert len(parts[1]) == 2
    assert len(parts[2]) == 2
