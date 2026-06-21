"""Tests for the git-based plugin installer."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from app.config import settings
from app.plugins.core.installer import (
    _INSTALL_JOBS,
    PluginInstallError,
    _validate_git_url,
    create_install_job,
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
