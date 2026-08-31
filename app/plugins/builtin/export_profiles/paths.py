"""Per-user export root resolution (Decision 13).

Output roots are per-user: ``<export_root>/<user_uuid>/<profile_slug>/…``.
The default root is ``data/users/<user_uuid>/exports/``; a custom root can be
configured via the plugin's ``export_root`` workspace setting, in which case
exports land at ``<export_root>/<user_uuid>/<profile_slug>/…``.
"""

from __future__ import annotations

from pathlib import Path

from app.config import settings

EXPORT_ROOT_SETTING_KEY = "export_root"


def default_user_export_dir(user_uuid: str) -> Path:
    """Default per-user export root: ``data/users/<user_uuid>/exports``."""
    return settings.database_dir / "users" / user_uuid / "exports"


def user_export_root(custom_root: str | None, user_uuid: str) -> Path:
    """Return the per-user export root honoring the optional custom root."""
    if custom_root and custom_root.strip():
        return Path(custom_root).expanduser() / user_uuid
    return default_user_export_dir(user_uuid)


def profile_destination_root(
    custom_root: str | None,
    user_uuid: str,
    profile_slug: str,
    destination: str,
) -> Path:
    """Resolve a profile's destination root with hard containment.

    The destination is a validated relative path (checked at profile save);
    this resolver re-checks containment defensively so a hand-edited setting
    cannot escape the per-user root.
    """
    base = (user_export_root(custom_root, user_uuid) / profile_slug).resolve()
    if not destination:
        return base
    target = (base / Path(*destination.replace("\\", "/").split("/"))).resolve()
    if target != base and base not in target.parents:
        raise ValueError(
            f"Profile destination escapes the per-user export root: {destination!r}"
        )
    return target
