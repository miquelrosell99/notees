"""Tests for the git-based plugin installer."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

from app.config import settings
from app.plugins.core.installer import (
    _INSTALL_JOBS,
    PluginInstallError,
    _validate_git_url,
    create_install_job,
    install_plugin_from_zip,
    run_install_job,
)


@pytest.mark.unit
@pytest.mark.parametrize(
    ("url", "should_raise"),
    [
        ("https://github.com/user/repo.git", False),
        ("https://gitlab.com/group/project", False),
        ("http://github.com/user/repo.git", True),
        ("git@github.com:user/repo.git", True),
        ("file:///tmp/repo.git", True),
        ("https://localhost/repo.git", True),
        ("https://127.0.0.1/repo.git", True),
        ("https://10.0.0.1/repo.git", True),
        ("https://192.168.1.1/repo.git", True),
        ("https://[::1]/repo.git", True),
        ("https://example.com/../repo.git", True),
    ],
)
def test_validate_git_url(url: str, should_raise: bool) -> None:
    if should_raise:
        with pytest.raises(PluginInstallError):
            _validate_git_url(url)
    else:
        assert _validate_git_url(url) == url


@pytest.fixture
def isolated_db_dir(monkeypatch, tmp_path):
    """Route plugin installs into a temp directory."""
    monkeypatch.setattr(settings, "database_dir", tmp_path)
    return tmp_path / "plugins"


@pytest.fixture(autouse=True)
def clean_jobs():
    """Clear the in-memory job registry between tests."""
    _INSTALL_JOBS.clear()
    yield
    _INSTALL_JOBS.clear()


def _make_clone_with_manifest(manifest: dict | str):
    """Return an async fake clone that writes a manifest into the temp dir."""
    async def fake_clone(git_url: str, target_dir: Path) -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        manifest_text = json.dumps(manifest) if isinstance(manifest, dict) else manifest
        (target_dir / "manifest.json").write_text(manifest_text)
    return fake_clone


@pytest.mark.unit
async def test_run_install_job_success(isolated_db_dir) -> None:
    job_id = create_install_job("https://example.com/repo.git")
    manifest = {
        "id": "notees.test",
        "name": "Test Plugin",
        "version": "1.0.0",
        "backend": {"entrypoint": "test:setup"},
    }

    with patch(
        "app.plugins.core.installer._clone_repository",
        new=_make_clone_with_manifest(manifest),
    ):
        await run_install_job(job_id, "https://example.com/repo.git")

    job = _INSTALL_JOBS[job_id]
    assert job["status"] == "completed"
    assert job["result"]["id"] == "notees.test"
    assert job["result"]["safe_id"] == "notees_test"
    assert (isolated_db_dir / "notees_test" / "manifest.json").exists()


@pytest.mark.unit
async def test_run_install_job_invalid_manifest(isolated_db_dir) -> None:
    job_id = create_install_job("https://example.com/repo.git")

    with patch(
        "app.plugins.core.installer._clone_repository",
        new=_make_clone_with_manifest("not valid json"),
    ):
        await run_install_job(job_id, "https://example.com/repo.git")

    job = _INSTALL_JOBS[job_id]
    assert job["status"] == "failed"
    assert job["error"]
    assert not (isolated_db_dir / "notees_test").exists()
    assert not (isolated_db_dir / ".install" / job_id).exists()


# ==================== ZIP INSTALLATION ====================

_ZIP_MANIFEST = {
    "id": "notees.ziptest",
    "name": "ZIP Test Plugin",
    "version": "1.0.0",
    "frontend": {"entrypoint": "dist/setup.js"},
}


def _make_zip(entries: dict[str, str | bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def _make_symlink_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("myplugin/manifest.json", json.dumps(_ZIP_MANIFEST))
        link = zipfile.ZipInfo("myplugin/link")
        # Unix symlink: file type S_IFLNK with 0777 permissions.
        link.external_attr = 0o120777 << 16
        archive.writestr(link, "/etc/passwd")
    return buffer.getvalue()


@pytest.fixture
def no_bound_app(monkeypatch):
    """Keep ZIP installs from activating into the global plugin manager."""
    from app.plugins.core.manager import plugin_manager

    monkeypatch.setattr(plugin_manager, "_app", None)


@pytest.mark.unit
async def test_install_from_zip_success(isolated_db_dir, no_bound_app) -> None:
    content = _make_zip(
        {
            "myplugin/manifest.json": json.dumps(_ZIP_MANIFEST),
            "myplugin/dist/setup.js": b"export function setup() {}",
        }
    )
    result = install_plugin_from_zip(content)

    assert result["id"] == "notees.ziptest"
    assert result["safe_id"] == "notees_ziptest"
    assert result["restart_required"] is True  # no app bound in this test
    assert (isolated_db_dir / "notees_ziptest" / "manifest.json").exists()
    assert (isolated_db_dir / "notees_ziptest" / "dist" / "setup.js").exists()
    # Temp extraction dir is cleaned up.
    assert not list((isolated_db_dir / ".install").glob("zip-*"))


@pytest.mark.unit
async def test_install_from_zip_replaces_existing(isolated_db_dir, no_bound_app) -> None:
    existing = isolated_db_dir / "notees_ziptest"
    existing.mkdir(parents=True)
    (existing / "stale.txt").write_text("old", encoding="utf-8")

    content = _make_zip({"myplugin/manifest.json": json.dumps(_ZIP_MANIFEST)})
    result = install_plugin_from_zip(content)

    assert result["id"] == "notees.ziptest"
    assert not (existing / "stale.txt").exists()
    assert (existing / "manifest.json").exists()


@pytest.mark.unit
@pytest.mark.parametrize(
    "entries",
    [
        {"myplugin/manifest.json": json.dumps(_ZIP_MANIFEST), "myplugin/../evil.txt": "x"},
        {"/absolute/manifest.json": json.dumps(_ZIP_MANIFEST)},
        {"myplugin/manifest.json": json.dumps(_ZIP_MANIFEST), "stray.txt": "x"},
        {
            "one/manifest.json": json.dumps(_ZIP_MANIFEST),
            "two/manifest.json": json.dumps(_ZIP_MANIFEST),
        },
        {"myplugin/README.md": "no manifest here"},
    ],
    ids=["traversal", "absolute-path", "stray-root-file", "two-top-folders", "no-manifest"],
)
async def test_install_from_zip_rejects_invalid_archives(
    isolated_db_dir, no_bound_app, entries
) -> None:
    with pytest.raises(PluginInstallError):
        install_plugin_from_zip(_make_zip(entries))
    # Nothing was extracted into the external dir.
    assert not (isolated_db_dir / "notees_ziptest").exists()


@pytest.mark.unit
async def test_install_from_zip_rejects_symlinks(isolated_db_dir, no_bound_app) -> None:
    with pytest.raises(PluginInstallError, match="symlink"):
        install_plugin_from_zip(_make_symlink_zip())
    assert not (isolated_db_dir / "notees_ziptest").exists()


@pytest.mark.unit
async def test_install_from_zip_rejects_non_zip(isolated_db_dir, no_bound_app) -> None:
    with pytest.raises(PluginInstallError, match="not a valid ZIP"):
        install_plugin_from_zip(b"this is not a zip archive")


@pytest.mark.unit
async def test_install_from_zip_rejects_oversized(isolated_db_dir, no_bound_app) -> None:
    from app.plugins.core import installer

    with pytest.raises(PluginInstallError, match="too large"):
        install_plugin_from_zip(b"x" * (installer.MAX_ZIP_SIZE + 1))
