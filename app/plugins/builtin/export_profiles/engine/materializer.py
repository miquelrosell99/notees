"""Materializer layer (Decision 31).

Writes file content to the export tree. ``copy`` is the v1 materializer:
bytes are streamed from the CAS blob to the destination with an atomic
temp-file-then-rename write, so a crashed run never leaves a partial file
at a managed path. (``symlink`` was considered and deliberately omitted:
CAS blobs are reference-counted and can be garbage-collected, which would
leave dangling links.)
"""

from __future__ import annotations

import contextlib
import shutil
import tempfile
from pathlib import Path
from typing import BinaryIO


class MaterializerError(Exception):
    """Raised when a file cannot be materialized."""


class CopyMaterializer:
    """Copy asset bytes into the export tree, rooted at a fixed directory."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _target(self, relative_path: str) -> Path:
        """Resolve a validated relative path inside the root (containment)."""
        target = (self.root / Path(*relative_path.split("/"))).resolve()
        root_resolved = self.root.resolve()
        if target != root_resolved and root_resolved not in target.parents:
            raise MaterializerError(f"Path escapes export root: {relative_path!r}")
        return target

    def copy(self, stream: BinaryIO, relative_path: str) -> int:
        """Write ``stream`` to ``relative_path`` atomically; return byte count."""
        target = self._target(relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".export_tmp_")
        try:
            with open(fd, "wb") as tmp_file:
                shutil.copyfileobj(stream, tmp_file)
            Path(tmp_name).replace(target)
        except Exception as exc:
            with contextlib.suppress(OSError):
                Path(tmp_name).unlink()
            raise MaterializerError(
                f"Failed to materialize {relative_path!r}: {exc}"
            ) from exc
        return target.stat().st_size

    def remove(self, relative_path: str) -> bool:
        """Delete a managed file; returns True when something was removed."""
        target = self._target(relative_path)
        if not target.is_file() and not target.is_symlink():
            return False
        target.unlink()
        return True

    def prune_empty_dirs(self) -> None:
        """Remove empty directories under the root (deepest first).

        Directories containing foreign files are left untouched; the root
        itself is always preserved.
        """
        if not self.root.is_dir():
            return
        for directory in sorted(
            (p for p in self.root.rglob("*") if p.is_dir()),
            key=lambda p: len(p.parts),
            reverse=True,
        ):
            with contextlib.suppress(OSError):
                directory.rmdir()  # only succeeds when empty
