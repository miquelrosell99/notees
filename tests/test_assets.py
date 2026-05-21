"""Tests for asset operations and lifecycle."""
import pytest
import shutil


@pytest.mark.asyncio
async def test_asset_folder_deletion(node_service, tmp_path):
    """Test that asset folders are deleted when asset nodes are soft-deleted."""
    from app.domain.services.asset_service import AssetService

    workspace_id = node_service._workspace_id

    test_assets_dir = tmp_path / "test_assets"
    test_assets_dir.mkdir(parents=True, exist_ok=True)

    asset_service = AssetService(workspace_uuid=str(workspace_id))

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
