"""Path validation and filename sanitization (engine layer, Decision 31).

Every provider-emitted relative path passes through this layer before the
reconciler/materializer see it. Rules:

- no absolute paths (POSIX or Windows drive), no NUL bytes;
- no ``..`` traversal segments — a path that would escape the destination
  root is *rejected*, not silently rewritten;
- filename sanitization: characters that are illegal or hostile on common
  filesystems are replaced, segments are trimmed, and length is capped.

Sanitization is deterministic so repeated resolutions over unchanged data
produce identical trees.
"""

from __future__ import annotations

import re

MAX_SEGMENT_LENGTH = 200
MAX_PATH_SEGMENTS = 32

# Characters replaced by '-' in a single path segment. Covers the Windows-
# reserved set and control characters; '/' and '\' are segment separators
# handled before this step and also rejected inside segments here.
_UNSAFE_SEGMENT_CHARS_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')
_WHITESPACE_RUN_RE = re.compile(r"\s+")


class PathValidationError(ValueError):
    """Raised when a provider-emitted path is unsafe or malformed."""


def sanitize_segment(segment: str) -> str:
    """Return a filesystem-safe single path segment (never empty)."""
    cleaned = _UNSAFE_SEGMENT_CHARS_RE.sub("-", segment)
    cleaned = _WHITESPACE_RUN_RE.sub(" ", cleaned)
    # Windows forbids trailing dots/spaces; leading dots make hidden files.
    cleaned = cleaned.strip(" .")
    if not cleaned:
        cleaned = "-"
    # Reserved Windows device names would break the tree on sync clients.
    if cleaned.split(".")[0].upper() in {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }:
        cleaned = f"_{cleaned}"
    return cleaned[:MAX_SEGMENT_LENGTH]


def validate_relative_path(path: str) -> list[str]:
    """Validate a provider-relative path and return its segments.

    Raises:
        PathValidationError: if the path is absolute, contains traversal,
            NUL bytes, or has no usable segments.
    """
    if not path or not path.strip():
        raise PathValidationError("Export path is empty")
    if "\0" in path:
        raise PathValidationError(f"Export path contains NUL: {path!r}")
    normalized = path.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise PathValidationError(f"Export path must be relative: {path!r}")
    segments = [s for s in normalized.split("/") if s not in ("", ".")]
    if not segments:
        raise PathValidationError("Export path has no segments")
    if len(segments) > MAX_PATH_SEGMENTS:
        raise PathValidationError(f"Export path is too deep: {path!r}")
    if any(segment == ".." for segment in segments):
        raise PathValidationError(f"Export path must not contain '..': {path!r}")
    return segments


def sanitize_relative_path(path: str) -> str:
    """Validate then sanitize ``path`` into a safe relative path string."""
    segments = validate_relative_path(path)
    return "/".join(sanitize_segment(segment) for segment in segments)
