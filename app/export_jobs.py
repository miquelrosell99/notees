"""Lightweight in-memory export job registry.

Used for long-running workspace exports. Jobs expire after a TTL
to prevent unbounded memory growth.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Protocol


class ProgressCallback(Protocol):
    def __call__(self, progress: int, status_text: str) -> None: ...


@dataclass
class ExportJob:
    id: str
    status: str  # pending | running | completed | failed
    progress: int  # 0-100
    status_text: str
    user_id: str | None = None
    workspace_id: int | None = None
    result_path: str | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    # Simple TTL: jobs older than this many seconds are considered stale
    TTL_SECONDS: float = field(default=3600.0, repr=False)

    @property
    def is_stale(self) -> bool:
        return time.time() - self.created_at > self.TTL_SECONDS


# In-memory job store. Suitable for self-hosted single-instance deployments.
_jobs: dict[str, ExportJob] = {}


def create_job(user_id: str | None = None, workspace_id: int | None = None) -> ExportJob:
    """Create a new export job."""
    _cleanup_stale()
    job = ExportJob(
        id=str(uuid.uuid4()),
        status="pending",
        progress=0,
        status_text="Starting export…",
        user_id=user_id,
        workspace_id=workspace_id,
    )
    _jobs[job.id] = job
    return job


def get_job(job_id: str) -> ExportJob | None:
    """Retrieve a job by ID."""
    _cleanup_stale()
    return _jobs.get(job_id)


def get_job_for_user(job_id: str, user_id: str) -> ExportJob | None:
    """Retrieve a job only if it belongs to the given user."""
    job = get_job(job_id)
    if job is None:
        return None
    if job.user_id is not None and job.user_id != user_id:
        return None
    return job


def update_job(job_id: str, **kwargs) -> None:
    """Update job fields."""
    job = _jobs.get(job_id)
    if job is None:
        return
    for key, value in kwargs.items():
        if hasattr(job, key):
            setattr(job, key, value)


def delete_job(job_id: str) -> None:
    """Remove a job from the registry."""
    _jobs.pop(job_id, None)


def _cleanup_stale() -> None:
    """Remove expired jobs."""
    stale = [jid for jid, job in _jobs.items() if job.is_stale]
    for jid in stale:
        _jobs.pop(jid, None)


def make_progress_callback(job_id: str) -> ProgressCallback:
    """Return a callback that updates the given job's progress."""

    def callback(progress: int, status_text: str) -> None:
        update_job(job_id, progress=progress, status_text=status_text)

    return callback
