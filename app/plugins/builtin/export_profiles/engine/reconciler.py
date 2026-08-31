"""Reconciler layer (Decision 31).

Compares the desired manifest with the engine-managed state from the previous
run and plans the filesystem changes needed to make the export tree track the
selection (``reconciliation_policy = sync``).

Foreign files — anything not recorded in the managed state — are never
modified or deleted under any policy. A desired path occupied by a foreign
file is reported as a conflict and left alone.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class CopyOperation:
    """A file the materializer must (re)write."""

    relative_path: str
    asset_uuid: str
    asset_hash: str
    size: int
    # True when this copy replaces an earlier managed version (move/update).
    replaces: str | None = None


@dataclass
class ConflictEntry:
    """A desired path blocked by a foreign (non-managed) file."""

    relative_path: str
    asset_uuid: str
    reason: str


@dataclass
class ReconcilePlan:
    """Planned changes for one reconciliation run."""

    copies: list[CopyOperation] = field(default_factory=list)
    deletes: list[str] = field(default_factory=list)
    conflicts: list[ConflictEntry] = field(default_factory=list)
    unchanged: int = 0


def plan_reconciliation(
    desired: dict[str, tuple[str, str, int]],
    managed: dict[str, dict[str, object]],
    root: Path,
) -> ReconcilePlan:
    """Plan copies/deletes to converge ``root`` onto ``desired``.

    Args:
        desired: mapping ``relative_path -> (asset_uuid, asset_hash, size)``
            for the freshly resolved manifest (paths already
            validated/sanitized).
        managed: mapping ``relative_path -> {"asset_uuid", "hash", "size"}``
            recorded by the previous run — the engine-managed file set.
        root: profile destination root on disk (used only to test existence
            and size; nothing is written here).

    A managed file whose on-disk size no longer matches the recorded size is
    treated as drift and re-copied. Determinism: copies and deletes are
    emitted in sorted-path order.
    """
    plan = ReconcilePlan()

    desired_paths = set(desired)
    managed_paths = set(managed)

    for path in sorted(desired_paths):
        asset_uuid, asset_hash, size = desired[path]
        existing = managed.get(path)
        target = root / Path(*path.split("/"))
        if existing is not None and existing.get("hash") == asset_hash and target.is_file():
            try:
                recorded_size = int(existing.get("size", -1))  # type: ignore[call-overload]
            except (TypeError, ValueError):
                recorded_size = -1
            if recorded_size == target.stat().st_size:
                plan.unchanged += 1
                continue
        if existing is None and target.exists():
            # A foreign file occupies the desired path — never overwrite.
            plan.conflicts.append(
                ConflictEntry(
                    relative_path=path,
                    asset_uuid=asset_uuid,
                    reason="path occupied by a foreign file",
                )
            )
            continue
        plan.copies.append(
            CopyOperation(
                relative_path=path,
                asset_uuid=asset_uuid,
                asset_hash=asset_hash,
                size=size,
                replaces=None if existing is None else path,
            )
        )

    # Managed paths that are no longer desired are deleted (moves land here:
    # the old templated path disappears from the manifest, the new one is
    # planned as a copy above).
    for path in sorted(managed_paths - desired_paths):
        plan.deletes.append(path)

    return plan
