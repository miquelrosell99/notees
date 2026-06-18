"""Tests for asset operations and lifecycle."""
import shutil
import uuid

import pytest


@pytest.mark.asyncio
async def test_asset_folder_deletion(node_service, tmp_path):
    """Test that asset folders are deleted when asset nodes are soft-deleted."""
    from app.features.assets.service import AssetFileService

    workspace_id = node_service._workspace_id

    test_assets_dir = tmp_path / "test_assets"
    test_assets_dir.mkdir(parents=True, exist_ok=True)

    asset_service = AssetFileService(workspace_uuid=str(workspace_id))

    original_assets_dir = asset_service.assets_dir
    asset_service.assets_dir = test_assets_dir

    try:
        test_file_content = b"Test image content"
        asset_uuid, extension = await asset_service.create_asset(
            file_bytes=test_file_content,
            original_filename="test.jpg",
            content_type="image/jpeg"
        )

        asset_folder = asset_service.get_asset_folder(asset_uuid)
        assert asset_folder.exists()
        assert asset_folder.is_dir()

        asset_node = await node_service.create_page("Test Asset")

        await node_service.delete_node(asset_node.id)

        success = asset_service.delete_asset(asset_uuid)
        assert success, "Asset folder deletion should succeed"

        assert not asset_folder.exists(), "Asset folder should be deleted"

    finally:
        asset_service.assets_dir = original_assets_dir
        if test_assets_dir.exists():
            shutil.rmtree(test_assets_dir)



@pytest.mark.asyncio
async def test_asset_service_rejects_invalid_uuid(node_service, tmp_path):
    """AssetFileService must reject malformed asset UUIDs."""
    from app.features.assets.service import AssetFileService, AssetPermissionError

    workspace_id = node_service._workspace_id
    test_assets_dir = tmp_path / "test_assets"
    test_assets_dir.mkdir(parents=True, exist_ok=True)

    asset_service = AssetFileService(workspace_uuid=str(workspace_id))
    original_assets_dir = asset_service.assets_dir
    asset_service.assets_dir = test_assets_dir

    try:
        for bad_uuid in ["not-a-uuid", "../etc/passwd", "..", "550e8400-e29b-41d4-a716-44665544000g"]:
            with pytest.raises(AssetPermissionError):
                asset_service.get_asset_folder(bad_uuid)
    finally:
        asset_service.assets_dir = original_assets_dir
        if test_assets_dir.exists():
            shutil.rmtree(test_assets_dir)


@pytest.mark.asyncio
async def test_asset_service_blocks_path_traversal(node_service, tmp_path):
    """AssetFileService must block UUIDs that resolve outside the assets directory."""
    from app.features.assets.service import AssetFileService, AssetPermissionError

    workspace_id = node_service._workspace_id
    test_assets_dir = tmp_path / "test_assets"
    test_assets_dir.mkdir(parents=True, exist_ok=True)

    asset_service = AssetFileService(workspace_uuid=str(workspace_id))
    original_assets_dir = asset_service.assets_dir
    asset_service.assets_dir = test_assets_dir

    try:
        # A valid UUID cannot contain "..", but if a caller somehow passed a
        # path-like name, resolve()+is_relative_to() must reject it.
        with pytest.raises(AssetPermissionError):
            asset_service.get_asset_folder("../../../../etc/passwd")
    finally:
        asset_service.assets_dir = original_assets_dir
        if test_assets_dir.exists():
            shutil.rmtree(test_assets_dir)


@pytest.mark.asyncio
async def test_asset_service_accepts_valid_uuid(node_service, tmp_path):
    """AssetFileService must accept a valid UUID and return a contained path."""
    from app.features.assets.service import AssetFileService

    workspace_id = node_service._workspace_id
    test_assets_dir = tmp_path / "test_assets"
    test_assets_dir.mkdir(parents=True, exist_ok=True)

    asset_service = AssetFileService(workspace_uuid=str(workspace_id))
    original_assets_dir = asset_service.assets_dir
    asset_service.assets_dir = test_assets_dir

    try:
        valid_uuid = str(uuid.uuid4())
        folder = asset_service.get_asset_folder(valid_uuid)
        assert folder.is_relative_to(test_assets_dir.resolve())
    finally:
        asset_service.assets_dir = original_assets_dir
        if test_assets_dir.exists():
            shutil.rmtree(test_assets_dir)
