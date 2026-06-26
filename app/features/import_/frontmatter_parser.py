"""Parse Markdown documents with YAML/TOML-style frontmatter."""

from __future__ import annotations

import re
from typing import Any

import yaml

_FRONTMATTER_RE = re.compile(
    r"^\s*(---|\+\+\+)\s*\n(.*?)\n\s*\1\s*\n?(.*)$",
    re.DOTALL,
)


def parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Split a Markdown document into frontmatter metadata and body.

    Supports both ``---`` (YAML) and ``+++`` (TOML-style) delimiters.
    For Milestone 6 only YAML is parsed; ``+++`` is accepted as a YAML
    delimiter for compatibility with common static-site generators.
    """
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return {}, content

    delimiter, frontmatter_text, body = match.groups()
    metadata: dict[str, Any] = {}
    if frontmatter_text.strip():
        try:
            loaded = yaml.safe_load(frontmatter_text)
            if isinstance(loaded, dict):
                metadata = loaded
        except yaml.YAMLError as exc:
            raise ValueError(f"Invalid frontmatter YAML: {exc}") from exc

    return metadata, body.lstrip("\n")


def normalize_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Return a normalized copy of frontmatter metadata with lower-cased keys."""
    normalized: dict[str, Any] = {}
    for key, value in metadata.items():
        if isinstance(key, str):
            normalized[key.lower()] = value
        else:
            normalized[str(key)] = value
    return normalized
