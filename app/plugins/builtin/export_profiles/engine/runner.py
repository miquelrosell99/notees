"""Engine runner: orchestrates the Decision 31 layers.

profile config → provider ``generate_manifest`` (no filesystem) → path
validation → reconciler (managed vs foreign) → materializer (copy). The
runner is the only layer that touches the export tree; providers and the
query engine stay pure.
"""

from __future__ import annotations

import io
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.logging_config import get_logger
from app.plugins.core.export import ExportManifest, ExportProvider, ExportServices

from ..profiles import ExportProfile
from .materializer import CopyMaterializer
from .reconciler import plan_reconciliation
from .validation import PathValidationError, sanitize_relative_path

logger = get_logger(__name__)

# Fixed timestamp for ZIP entries so repeated exports over unchanged data
# are byte-identical (reproducibility requirement).
_ZIP_FIXED_DATE = (2000, 1, 1, 0, 0, 0)


@dataclass
class InvalidPathEntry:
    relative_path: str
    asset_uuid: str
    reason: str


@dataclass
class ReconcileReport:
    """Outcome of one reconciliation run (also persisted as last-run state)."""

    profile_id: str
    profile_slug: str
    root: str
    created: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    unchanged: int = 0
    conflicts: list[dict[str, str]] = field(default_factory=list)
    invalid: list[dict[str, str]] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)

    @property
    def file_count(self) -> int:
        return len(self.created) + len(self.updated) + self.unchanged

    def to_dict(self) -> dict[str, Any]:
        return {
            "profile_id": self.profile_id,
            "profile_slug": self.profile_slug,
            "root": self.root,
            "created": self.created,
            "updated": self.updated,
            "deleted": self.deleted,
            "unchanged": self.unchanged,
            "conflicts": self.conflicts,
            "invalid": self.invalid,
            "skipped": self.skipped,
            "errors": self.errors,
            "file_count": self.file_count,
        }


class ProviderNotFoundError(Exception):
    """Raised when a profile references an unregistered provider."""


async def resolve_manifest(
    profile: ExportProfile,
    services: ExportServices,
    provider_lookup: Callable[[str], ExportProvider | None],
) -> ExportManifest:
    """Run the pure resolution layers: query → contexts → provider manifest."""
    provider = provider_lookup(profile.provider)
    if provider is None:
        raise ProviderNotFoundError(
            f"Export provider {profile.provider!r} is not registered"
        )
    node_ids = await services.select_node_ids(profile.query)
    contexts = await services.build_node_contexts(node_ids)
    return provider.generate_manifest(profile.provider_config, contexts, services)


async def _desired_files(
    manifest: ExportManifest,
    services: ExportServices,
    report: ReconcileReport,
) -> dict[str, tuple[str, str, int]]:
    """Validate/sanitize manifest paths and attach asset hash/size.

    Invalid paths are reported and excluded; they never reach the
    reconciler, so a malicious or buggy provider cannot escape the tree.
    """
    desired: dict[str, tuple[str, str, int]] = {}
    for export_file in manifest.files:
        try:
            # A leading "/" roots the rendered path at the profile
            # destination (template convention); it is not an absolute path.
            safe_path = sanitize_relative_path(
                export_file.relative_path.lstrip("/\\")
            )
        except PathValidationError as exc:
            report.invalid.append(
                {
                    "relative_path": export_file.relative_path,
                    "asset_uuid": export_file.asset_uuid,
                    "reason": str(exc),
                }
            )
            continue
        if safe_path in desired:
            report.invalid.append(
                {
                    "relative_path": export_file.relative_path,
                    "asset_uuid": export_file.asset_uuid,
                    "reason": "duplicate path after sanitization",
                }
            )
            continue
        metadata = await services.get_asset_metadata(export_file.asset_uuid)
        if metadata is None:
            report.errors.append(
                {
                    "relative_path": export_file.relative_path,
                    "asset_uuid": export_file.asset_uuid,
                    "reason": "asset metadata unavailable",
                }
            )
            continue
        desired[safe_path] = (
            export_file.asset_uuid,
            metadata.asset_hash,
            metadata.size,
        )
    return desired


async def reconcile_profile(
    profile: ExportProfile,
    root: Path,
    managed: dict[str, dict[str, object]],
    services: ExportServices,
    provider_lookup: Callable[[str], ExportProvider | None],
) -> tuple[ReconcileReport, dict[str, dict[str, object]]]:
    """Reconcile one profile's export tree; return (report, new managed state)."""
    report = ReconcileReport(
        profile_id=profile.id, profile_slug=profile.slug, root=str(root)
    )
    manifest = await resolve_manifest(profile, services, provider_lookup)
    report.skipped.extend(
        {"node_uuid": s.node_uuid, "title": s.title, "reason": s.reason}
        for s in manifest.skipped
    )

    desired = await _desired_files(manifest, services, report)
    materializer = CopyMaterializer(root)
    plan = plan_reconciliation(desired, managed, root)

    new_managed: dict[str, dict[str, object]] = {}
    # Unchanged files stay managed.
    copy_paths = {c.relative_path for c in plan.copies}
    conflict_paths = {c.relative_path for c in plan.conflicts}
    for path in sorted(desired):
        if path in managed and path not in copy_paths and path not in conflict_paths:
            new_managed[path] = dict(managed[path])

    for copy_op in plan.copies:
        stream = await services.open_asset_stream(copy_op.asset_uuid)
        if stream is None:
            report.errors.append(
                {
                    "relative_path": copy_op.relative_path,
                    "asset_uuid": copy_op.asset_uuid,
                    "reason": "asset bytes unavailable",
                }
            )
            continue
        try:
            with stream:
                size = materializer.copy(stream, copy_op.relative_path)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Export materialization failed for %s: %s",
                copy_op.relative_path,
                exc,
            )
            report.errors.append(
                {
                    "relative_path": copy_op.relative_path,
                    "asset_uuid": copy_op.asset_uuid,
                    "reason": str(exc),
                }
            )
            continue
        new_managed[copy_op.relative_path] = {
            "asset_uuid": copy_op.asset_uuid,
            "hash": copy_op.asset_hash,
            "size": size,
        }
        if copy_op.replaces is None:
            report.created.append(copy_op.relative_path)
        else:
            report.updated.append(copy_op.relative_path)

    for path in plan.deletes:
        if materializer.remove(path):
            report.deleted.append(path)

    materializer.prune_empty_dirs()

    report.conflicts.extend(
        {
            "relative_path": conflict.relative_path,
            "asset_uuid": conflict.asset_uuid,
            "reason": conflict.reason,
        }
        for conflict in plan.conflicts
    )
    report.unchanged = plan.unchanged
    return report, new_managed


async def export_profile_zip(
    profile: ExportProfile,
    services: ExportServices,
    provider_lookup: Callable[[str], ExportProvider | None],
) -> tuple[bytes, ReconcileReport]:
    """Resolve a profile into an in-memory ZIP (manual "export ZIP" action).

    Uses the same resolution layers as continuous reconciliation but never
    touches the export tree. Entries are written in sorted order with a
    fixed timestamp so repeated exports are byte-identical.
    """
    report = ReconcileReport(profile_id=profile.id, profile_slug=profile.slug, root="zip")
    manifest = await resolve_manifest(profile, services, provider_lookup)
    report.skipped.extend(
        {"node_uuid": s.node_uuid, "title": s.title, "reason": s.reason}
        for s in manifest.skipped
    )
    desired = await _desired_files(manifest, services, report)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(desired):
            asset_uuid, _asset_hash, _size = desired[path]
            stream = await services.open_asset_stream(asset_uuid)
            if stream is None:
                report.errors.append(
                    {
                        "relative_path": path,
                        "asset_uuid": asset_uuid,
                        "reason": "asset bytes unavailable",
                    }
                )
                continue
            with stream:
                data = stream.read()
            info = zipfile.ZipInfo(filename=path, date_time=_ZIP_FIXED_DATE)
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
            report.created.append(path)
    return buffer.getvalue(), report
