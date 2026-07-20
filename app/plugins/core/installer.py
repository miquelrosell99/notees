"""Git-based plugin installer.

Clones remote plugin repositories into the external plugin directory and
validates their manifests. Long-running installs are tracked with an in-memory
job registry so callers can poll for status.
"""

from __future__ import annotations

import asyncio
import ipaddress
import shutil
import traceback
import uuid
from pathlib import Path
from urllib.parse import urlparse

from app.config import settings
from app.logging_config import get_logger

from .exceptions import PluginInstallError
from .manifest import PluginManifest

logger = get_logger(__name__)

_INSTALL_JOBS: dict[str, dict] = {}


def _private_ip_ranges() -> list[ipaddress._BaseNetwork]:  # type: ignore[name-defined]
    """Networks that should not be reachable from the installer."""
    return [
        ipaddress.ip_network("127.0.0.0/8"),
        ipaddress.ip_network("10.0.0.0/8"),
        ipaddress.ip_network("172.16.0.0/12"),
        ipaddress.ip_network("192.168.0.0/16"),
        ipaddress.ip_network("169.254.0.0/16"),
        ipaddress.ip_network("::1/128"),
        ipaddress.ip_network("fc00::/7"),
        ipaddress.ip_network("fe80::/10"),
    ]


def _validate_git_url(url: str) -> str:
    """Normalize and validate a plugin git URL.

    Raises:
        PluginInstallError: if the URL is not a safe HTTPS git URL.
    """
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise PluginInstallError("Only https:// git URLs are allowed")
    if not parsed.hostname:
        raise PluginInstallError("Git URL is missing a host")

    hostname = parsed.hostname.lower()
    if hostname in ("localhost",):
        raise PluginInstallError("Localhost git URLs are not allowed")

    try:
        host_ip = ipaddress.ip_address(hostname)
        for network in _private_ip_ranges():
            if host_ip in network:
                raise PluginInstallError("Private/network git URLs are not allowed")
    except ValueError:
        # hostname is not a literal IP; acceptable.
        pass

    if parsed.path.count(".."):
        raise PluginInstallError("Invalid path in git URL")

    return url


def _external_plugin_dir() -> Path:
    """Return the directory where user-installed plugins live."""
    directory = settings.database_dir / "plugins"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def create_install_job(git_url: str) -> str:
    """Create a pending install job and return its id."""
    job_id = str(uuid.uuid4())
    _INSTALL_JOBS[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "git_url": git_url,
        "progress": None,
        "result": None,
        "error": None,
    }
    return job_id


def get_install_job(job_id: str) -> dict | None:
    """Return the current state of an install job."""
    return _INSTALL_JOBS.get(job_id)


async def _clone_repository(git_url: str, target_dir: Path) -> None:
    """Clone a git repository into ``target_dir``."""
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    proc = await asyncio.create_subprocess_exec(
        "git",
        "clone",
        "--depth",
        "1",
        git_url,
        str(target_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip() or stdout.decode(errors="replace").strip()
        raise PluginInstallError(f"git clone failed: {detail}")


def _update_job(job_id: str, **fields) -> None:
    """Update fields on a job record if it still exists."""
    job = _INSTALL_JOBS.get(job_id)
    if job is not None:
        job.update(fields)


async def run_install_job(job_id: str, git_url: str) -> None:
    """Run the install job and update its status.

    This function is module-level so it can be used safely with
    ``asyncio.create_task``.
    """
    _update_job(job_id, status="running", progress="Cloning repository")
    external_dir = _external_plugin_dir()
    temp_dir = external_dir / ".install" / job_id
    final_dir: Path | None = None

    try:
        git_url = _validate_git_url(git_url)

        if temp_dir.exists():
            shutil.rmtree(temp_dir)

        await _clone_repository(git_url, temp_dir)

        _update_job(job_id, progress="Validating manifest")
        manifest_path = temp_dir / "manifest.json"
        manifest = PluginManifest.from_file(manifest_path)

        safe_id = manifest.safe_id
        if not safe_id:
            raise PluginInstallError("Plugin manifest produced an empty safe id")

        final_dir = external_dir / safe_id
        if final_dir.exists():
            shutil.rmtree(final_dir)
        temp_dir.rename(final_dir)

        # Activate the plugin immediately if the app is bound.
        try:
            from .manager import plugin_manager

            if plugin_manager._app is not None:
                plugin_manager.load_plugin_dir(final_dir)
                restart_required = False
            else:
                restart_required = True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Plugin %s installed but could not be activated: %s", manifest.id, exc)
            restart_required = True

        _update_job(
            job_id,
            status="completed",
            progress=None,
            result={
                "id": manifest.id,
                "name": manifest.name,
                "version": manifest.version,
                "safe_id": safe_id,
                "restart_required": restart_required,
            },
        )
        logger.info("Installed plugin %s from %s", manifest.id, git_url)

    except Exception as exc:  # noqa: BLE001
        logger.exception("Plugin install failed for %s", git_url)
        _update_job(
            job_id,
            status="failed",
            progress=None,
            error=str(exc) or traceback.format_exc(),
        )
        if final_dir is not None and final_dir.exists():
            shutil.rmtree(final_dir, ignore_errors=True)
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)
