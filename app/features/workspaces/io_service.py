"""Workspace import/export and restore service.

Contains all non-SQL logic: UUID remapping helpers, file I/O, progress
callbacks, ZIP handling, and orchestration. SQL execution is delegated to a
``WorkspaceIORepository`` implementation.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.domain.ports import NodeExportRenderer
from app.features.workspaces.manager import _active_workspaces, _get_numeric_user_id
from app.features.workspaces.port import WorkspaceIORepository
from app.logging_config import get_logger

if TYPE_CHECKING:
    from app.features.export.port import ExportRepository

logger = get_logger(__name__)


class WorkspaceIOService:
    """Orchestrates workspace import/export/restore operations."""

    def __init__(
        self,
        repo: WorkspaceIORepository,
        data_dir: Path,
        export_repo: ExportRepository,
        renderer: NodeExportRenderer,
        user_id: int | None = None,
    ):
        self._repo = repo
        self._data_dir = data_dir
        self._export_repo = export_repo
        self._renderer = renderer
        self._user_id = user_id

    async def _resolve_user_id(self, user_id_str: str) -> int:
        """Convert a string user ID to the numeric PostgreSQL ID."""
        if self._user_id is not None:
            return self._user_id
        numeric_user_id = await _get_numeric_user_id(user_id_str)
        if not numeric_user_id:
            raise ValueError(f"User not found: {user_id_str}")
        return numeric_user_id

    async def export_workspace_to_file(self, user_id_str: str, workspace_name: str) -> Path:
        """Export a workspace to a comprehensive JSON dump file."""
        user_id = await self._resolve_user_id(user_id_str)
        workspace = await self._repo.get_workspace_by_name_for_user(workspace_name, user_id)
        if not workspace:
            raise ValueError(f"Workspace '{workspace_name}' not found")

        workspace_id = workspace["id"]
        workspace_uuid = str(workspace["uuid"])

        dump_data = await self._repo.export_workspace_full(workspace_id)

        export_dir = self._data_dir / "workspaces" / workspace_uuid / "export"
        export_dir.mkdir(parents=True, exist_ok=True)
        export_path = export_dir / f"{workspace_name}_dump.json"

        with open(export_path, "w", encoding="utf-8") as f:
            json.dump(dump_data, f, default=str, indent=2)

        file_size_mb = export_path.stat().st_size / (1024 * 1024)
        logger.info(f"Exported workspace '{workspace_name}' to {export_path} ({file_size_mb:.2f} MB)")

        return export_path

    async def export_workspace_by_uuid(self, user_id_str: str, workspace_uuid: str) -> Path:
        """Export a workspace by UUID to a comprehensive JSON dump file."""
        user_id = await self._resolve_user_id(user_id_str)
        workspace = await self._repo.get_workspace_by_uuid_for_user(workspace_uuid, user_id)
        if not workspace:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = workspace["id"]
        ws_name = workspace["name"]

        dump_data = await self._repo.export_workspace_full(workspace_id)

        export_dir = self._data_dir / "workspaces" / workspace_uuid / "export"
        export_dir.mkdir(parents=True, exist_ok=True)
        export_path = export_dir / f"{ws_name}_dump.json"

        with open(export_path, "w", encoding="utf-8") as f:
            json.dump(dump_data, f, default=str, indent=2)

        return export_path

    async def export_workspace_zip(
        self,
        user_id_str: str,
        workspace_uuid: str,
        progress_callback: Any = None,
    ) -> Path:
        """Export a workspace as a ZIP containing the JSON dump and all asset files."""
        user_id = await self._resolve_user_id(user_id_str)
        workspace = await self._repo.get_workspace_by_uuid_for_user(workspace_uuid, user_id)
        if not workspace:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = workspace["id"]
        ws_name = workspace["name"]
        ws_uuid = str(workspace["uuid"])

        if progress_callback:
            progress_callback(5, "Fetching workspace data…")

        dump_data = await self._repo.export_workspace_full(workspace_id)

        if progress_callback:
            progress_callback(25, "Building ZIP archive…")

        export_dir = self._data_dir / "workspaces" / ws_uuid / "export"
        export_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        zip_path = export_dir / f"{ws_name}_dump_{timestamp}.zip"

        assets_dir = self._data_dir / "workspaces" / ws_uuid / "assets"
        asset_folders = [f for f in assets_dir.iterdir() if f.is_dir()] if assets_dir.exists() else []
        total_assets = sum(1 for folder in asset_folders for _ in folder.iterdir() if _.is_file())

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            dump_json = json.dumps(dump_data, default=str, indent=2)
            zf.writestr("dump.json", dump_json)

            if progress_callback:
                progress_callback(50, "Copying asset files…")

            copied = 0
            if assets_dir.exists():
                for asset_folder in asset_folders:
                    if asset_folder.is_dir():
                        for asset_file in asset_folder.iterdir():
                            if asset_file.is_file():
                                arcname = f"assets/{asset_folder.name}/{asset_file.name}"
                                zf.write(asset_file, arcname)
                                copied += 1
                                if progress_callback and total_assets > 0:
                                    progress = 50 + int((copied / total_assets) * 45)
                                    progress_callback(progress, f"Copying asset files ({copied}/{total_assets})…")

        if progress_callback:
            progress_callback(100, "Export complete")

        file_size_mb = zip_path.stat().st_size / (1024 * 1024)
        logger.info(f"Exported workspace '{ws_name}' as ZIP to {zip_path} ({file_size_mb:.2f} MB)")

        return zip_path

    async def export_workspace_formatted_zip(
        self,
        user_id_str: str,
        workspace_uuid: str,
        format: str,
        include_assets: bool = False,
        progress_callback: Any = None,
    ) -> Path:
        """Export all pages in a workspace as a ZIP of formatted files."""
        if format not in ("markdown", "text", "json"):
            raise ValueError(f"Invalid format: {format}")

        user_id = await self._resolve_user_id(user_id_str)
        workspace = await self._repo.get_workspace_by_uuid_for_user(workspace_uuid, user_id)
        if not workspace:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = workspace["id"]
        ws_name = workspace["name"]
        ws_uuid = str(workspace["uuid"])

        if progress_callback:
            progress_callback(5, "Fetching pages…")

        page_rows = await self._repo.list_page_uuids(workspace_id)
        page_uuids = [row["uuid"] for row in page_rows]

        asset_path_map: dict[str, str] = {}
        asset_files: dict[str, Path] = {}
        if include_assets:
            from app.features.assets.utils import get_extension_from_content_type

            asset_rows = await self._repo.list_asset_files(workspace_id)
            assets_dir = self._data_dir / "workspaces" / ws_uuid / "assets"
            for row in asset_rows:
                asset_uuid = row["uuid"]
                file_hash = row["hash"]
                mime_type = row["mime_type"] or ""
                extension = get_extension_from_content_type(mime_type)
                if not extension:
                    continue
                file_path = assets_dir / file_hash[:4] / f"{file_hash}{extension}"
                if file_path.exists() and file_path.is_file():
                    rel_path = f"./assets/{file_hash[:4]}/{file_path.name}"
                    asset_path_map[asset_uuid] = rel_path
                    asset_files[asset_uuid] = file_path

        from app.features.export.service import ExportService

        export_service = ExportService(self._export_repo, self._renderer)

        total_pages = len(page_uuids)
        if total_pages == 0:
            raise ValueError("No pages found in workspace")

        if progress_callback:
            progress_callback(10, f"Exporting {total_pages} pages…")

        export_dir = self._data_dir / "workspaces" / ws_uuid / "export"
        export_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        fmt_code = {"markdown": "md", "text": "txt", "json": "json"}[format]
        zip_path = export_dir / f"{ws_name}_{fmt_code}_{timestamp}.zip"

        ext = {"markdown": "md", "text": "txt", "json": "json"}[format]
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, node_uuid in enumerate(page_uuids):
                try:
                    content_bytes, _fn, _mime = await export_service.export_nodes(
                        workspace_uuid=workspace_uuid,
                        node_uuids=[node_uuid],
                        format=format,
                        include_children=True,
                        layout="outline",
                        formatting=False,
                        properties="none",
                        link_style="raw",
                        asset_path_map=asset_path_map if include_assets and format == "markdown" else None,
                        highlight_syntax=False,
                        link_target_brackets=False,
                    )
                    content = content_bytes.decode("utf-8")

                    if format == "markdown":
                        metadata = await self._repo.get_page_metadata(
                            workspace_id, node_uuid, include_properties=True
                        )
                        frontmatter = self._renderer.build_yaml_frontmatter(metadata)
                        content = frontmatter + content

                    filename = f"{node_uuid}.{ext}"
                    zf.writestr(filename, content)
                except Exception as exc:
                    logger.warning(f"Failed to export page {node_uuid}: {exc}")
                    continue

                if progress_callback:
                    progress = 10 + int(((i + 1) / total_pages) * 80)
                    progress_callback(progress, f"Exported page {i + 1} of {total_pages}…")

            if include_assets:
                total_assets = len(asset_files)
                for idx, (_asset_uuid, file_path) in enumerate(asset_files.items()):
                    arcname = f"assets/{file_path.parent.name}/{file_path.name}"
                    zf.write(file_path, arcname)
                    if progress_callback:
                        progress = 90 + int(((idx + 1) / total_assets) * 10)
                        progress_callback(progress, f"Copying asset files ({idx + 1}/{total_assets})…")

        if progress_callback:
            progress_callback(100, "Export complete")

        return zip_path

    async def import_dump_to_new_workspace(
        self,
        user_id_str: str,
        dump_data: dict,
        workspace_name: str,
        remap_uuids: bool = True,
        cleanup_invalid_cloze: bool = False,
    ) -> dict:
        """Import a dump file into a brand new workspace."""
        user_id = await self._resolve_user_id(user_id_str)

        ws_row = await self._repo.create_workspace_for_import(workspace_name, user_id)
        workspace_id = ws_row["id"]
        workspace_uuid = str(ws_row["uuid"])

        logger.info(f"Created workspace '{workspace_name}' (id={workspace_id}, uuid={workspace_uuid}) for import")

        stats, uuid_map = await self._repo.import_dump(
            workspace_id,
            user_id,
            dump_data,
            remap_uuids=remap_uuids,
            cleanup_invalid_cloze=cleanup_invalid_cloze,
        )

        _active_workspaces[user_id_str] = workspace_uuid

        return {
            "uuid": workspace_uuid,
            "name": workspace_name,
            "created_at": ws_row["create_date"].isoformat() if ws_row.get("create_date") else None,
            "stats": stats,
            "uuid_map": uuid_map,
        }

    async def import_workspace_from_zip(
        self,
        user_id_str: str,
        zip_path: Path,
        workspace_name: str,
        cleanup_invalid_cloze: bool = False,
    ) -> dict:
        """Import a workspace from a ZIP file containing dump.json and assets."""
        import tempfile as _tempfile

        if not zipfile.is_zipfile(zip_path):
            raise ValueError("Invalid ZIP file")

        with _tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            with zipfile.ZipFile(zip_path, "r") as zf:
                for info in zf.infolist():
                    target = (tmpdir_path / info.filename).resolve()
                    if not str(target).startswith(str(tmpdir_path.resolve())):
                        raise ValueError("ZIP contains unsafe path entries")
                zf.extractall(tmpdir_path)

            dump_json_path = tmpdir_path / "dump.json"
            if not dump_json_path.exists():
                raise ValueError("ZIP file does not contain dump.json")

            with open(dump_json_path, encoding="utf-8") as f:
                dump_data = json.load(f)

            result = await self.import_dump_to_new_workspace(
                user_id_str=user_id_str,
                dump_data=dump_data,
                workspace_name=workspace_name,
                remap_uuids=False,
                cleanup_invalid_cloze=cleanup_invalid_cloze,
            )

            new_workspace_uuid = result["uuid"]
            result.pop("uuid_map", None)

            extracted_assets = tmpdir_path / "assets"
            if extracted_assets.exists() and extracted_assets.is_dir():
                new_assets_dir = self._data_dir / "workspaces" / new_workspace_uuid / "assets"
                shutil.copytree(extracted_assets, new_assets_dir, dirs_exist_ok=True)
                logger.info(f"Copied assets for workspace '{workspace_name}' to {new_assets_dir}")

        return result

    async def restore_workspace_from_dump(
        self,
        user_id_str: str,
        workspace_uuid: str,
        dump_data: dict,
        cleanup_invalid_cloze: bool = False,
    ) -> dict:
        """Restore an existing workspace to a previous state from a dump file."""
        user_id = await self._resolve_user_id(user_id_str)

        workspace = await self._repo.get_workspace_by_uuid_for_user(workspace_uuid, user_id)
        if not workspace:
            raise ValueError(f"Workspace '{workspace_uuid}' not found")

        workspace_id = workspace["id"]
        logger.warning(f"Restoring workspace '{workspace['name']}' (id={workspace_id}) - DELETING ALL EXISTING DATA")

        stats, _ = await self._repo.restore_workspace(
            workspace_id, user_id, dump_data, cleanup_invalid_cloze=cleanup_invalid_cloze
        )

        return {
            "uuid": workspace_uuid,
            "name": workspace["name"],
            "stats": stats,
        }
