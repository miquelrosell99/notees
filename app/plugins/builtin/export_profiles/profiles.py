"""Export profile configuration model and workspace-settings storage.

Profiles are stored as JSON in workspace settings (no new op types/tables)
under the plugin-namespaced key ``profiles``. A profile selects nodes via a
QueryAST or a saved-query reference and describes how the export tree is
produced (provider, destination, materializer, reconciliation policy).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

PROFILES_SETTING_KEY = "profiles"

SUPPORTED_MATERIALIZERS = {"copy"}
SUPPORTED_RECONCILIATION_POLICIES = {"sync"}

_SLUG_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


class ProfileValidationError(ValueError):
    """Raised when a profile definition is invalid or unsafe."""


@dataclass
class ExportProfile:
    """A named export profile (Decision 31 config layer)."""

    id: str
    name: str
    enabled: bool = True
    provider: str = "bibliographic"
    # {"ast": {...}} or {"saved_query_id": "<node_view uuid>"}
    query: dict[str, Any] = field(default_factory=dict)
    # Relative path under the per-user root; "" means the root itself.
    destination: str = ""
    materializer: str = "copy"
    reconciliation_policy: str = "sync"
    provider_config: dict[str, Any] = field(default_factory=dict)

    @property
    def slug(self) -> str:
        """Filesystem-safe slug used for the profile's output folder."""
        return profile_slug(self.name, fallback=self.id)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled,
            "provider": self.provider,
            "query": self.query,
            "destination": self.destination,
            "materializer": self.materializer,
            "reconciliation_policy": self.reconciliation_policy,
            "provider_config": self.provider_config,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> ExportProfile:
        return ExportProfile(
            id=str(data.get("id") or ""),
            name=str(data.get("name") or ""),
            enabled=bool(data.get("enabled", True)),
            provider=str(data.get("provider") or "bibliographic"),
            query=dict(data.get("query") or {}),
            destination=str(data.get("destination") or ""),
            materializer=str(data.get("materializer") or "copy"),
            reconciliation_policy=str(data.get("reconciliation_policy") or "sync"),
            provider_config=dict(data.get("provider_config") or {}),
        )


def profile_slug(name: str, *, fallback: str) -> str:
    """Return a lowercase, filesystem-safe slug for ``name``."""
    slug = _SLUG_NON_ALNUM_RE.sub("-", name.lower()).strip("-")
    return slug or fallback


def _validate_relative_destination(destination: str) -> None:
    """Reject absolute paths and traversal in a profile destination."""
    if not destination:
        return
    normalized = destination.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise ProfileValidationError(
            f"Destination must be a relative path, got {destination!r}"
        )
    if any(segment == ".." for segment in normalized.split("/")):
        raise ProfileValidationError(
            f"Destination must not contain '..' segments, got {destination!r}"
        )


def validate_filename_template(template: str) -> None:
    """Reject templates that could escape the profile destination.

    A leading ``/`` roots the rendered path at the destination (it does not
    make the path absolute); ``..`` segments are never allowed, whether they
    appear as literals or would be produced verbatim by a token-free
    template. Token output is additionally sanitized at render time.
    """
    if not template or not template.strip():
        raise ProfileValidationError("Filename template must not be empty")
    normalized = template.replace("\\", "/").lstrip("/")
    for segment in normalized.split("/"):
        # Segments that are purely a traversal literal.
        if segment == "..":
            raise ProfileValidationError(
                f"Filename template must not contain '..' segments, got {template!r}"
            )
    if "\0" in template:
        raise ProfileValidationError("Filename template must not contain NUL")


def validate_profile(data: dict[str, Any]) -> ExportProfile:
    """Validate a raw profile dict and return the parsed profile."""
    profile = ExportProfile.from_dict(data)
    if not profile.id:
        raise ProfileValidationError("Profile id is required")
    if not profile.name.strip():
        raise ProfileValidationError("Profile name is required")
    if not profile.provider:
        raise ProfileValidationError("Profile provider is required")

    has_ast = isinstance(profile.query.get("ast"), dict)
    has_saved = bool(profile.query.get("saved_query_id"))
    if has_ast == has_saved:
        raise ProfileValidationError(
            "Profile query must contain exactly one of 'ast' or 'saved_query_id'"
        )

    _validate_relative_destination(profile.destination)

    if profile.materializer not in SUPPORTED_MATERIALIZERS:
        raise ProfileValidationError(
            f"Unsupported materializer {profile.materializer!r}; "
            f"supported: {sorted(SUPPORTED_MATERIALIZERS)}"
        )
    if profile.reconciliation_policy not in SUPPORTED_RECONCILIATION_POLICIES:
        raise ProfileValidationError(
            f"Unsupported reconciliation policy {profile.reconciliation_policy!r}; "
            f"supported: {sorted(SUPPORTED_RECONCILIATION_POLICIES)}"
        )

    template = profile.provider_config.get("filename_template")
    if template is not None:
        validate_filename_template(str(template))

    return profile


def parse_profiles(raw: Any) -> list[ExportProfile]:
    """Parse the stored settings value into profiles (lenient on shape)."""
    if not isinstance(raw, list):
        return []
    profiles: list[ExportProfile] = []
    for item in raw:
        if isinstance(item, dict):
            profiles.append(ExportProfile.from_dict(item))
    return profiles
