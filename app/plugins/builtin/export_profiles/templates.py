"""Filename template rendering for export profiles.

Mirrors the citekey pattern interpreter (``app/domain/services/citekey.py``):
``{token}`` placeholders with optional ``:lower``/``:upper`` modifiers,
deterministic fallbacks for unresolvable tokens, and deterministic
collision suffixes.

Fallback chain per token: the token's resolved value → the source title →
the source UUID. Template paths are rooted at the profile destination; a
leading ``/`` is allowed and stripped. Unsafe characters are left for the
engine's path-validation layer, which sanitizes per segment — this module
only resolves tokens deterministically.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

_TOKEN_RE = re.compile(r"\{([A-Za-z_]+)(?::(lower|upper))?\}")

# Canonical token aliases (the PRD's acceptance examples use both spellings).
_TOKEN_ALIASES = {
    "ext": "extension",
}


def render_filename_template(
    template: str,
    tokens: dict[str, str | None],
    *,
    title: str | None,
    fallback_uuid: str,
) -> str:
    """Render a filename template against resolved token values.

    Unknown or empty tokens fall back to ``title`` and then to
    ``fallback_uuid``, so a rendered path is never empty. Literal text
    outside tokens is preserved verbatim.
    """
    normalized_tokens: dict[str, str | None] = {}
    for name, value in tokens.items():
        lowered = name.lower()
        normalized_tokens[_TOKEN_ALIASES.get(lowered, lowered)] = value

    fallback = title.strip() if title and title.strip() else fallback_uuid
    emitted: list[str] = []
    last_end = 0

    for match in _TOKEN_RE.finditer(template):
        emitted.append(template[last_end : match.start()])
        last_end = match.end()

        # Token names are case-insensitive; aliases normalize {ext} → {extension}.
        token = _TOKEN_ALIASES.get(match.group(1).lower(), match.group(1).lower())
        modifier = match.group(2)
        value = normalized_tokens.get(token)
        if not value or not str(value).strip():
            value = fallback
        value = str(value).strip()
        if modifier == "lower":
            value = value.lower()
        elif modifier == "upper":
            value = value.upper()
        emitted.append(value)

    emitted.append(template[last_end:])
    rendered = "".join(emitted).strip()
    return rendered or fallback_uuid


def resolve_filename_collisions(
    candidates: Iterable[tuple[str, str]],
) -> dict[str, str]:
    """Assign collision-free paths deterministically.

    ``candidates`` yields ``(key, desired_path)`` pairs; keys must be unique
    and sortable (e.g. asset UUIDs). When two keys want the same path, the
    deterministically first key (sorted order) keeps it and later keys get
    ``name-2.ext``, ``name-3.ext``, … suffixes. Returns ``key -> path``.
    """
    ordered = sorted(candidates, key=lambda pair: (pair[1], pair[0]))
    assigned: dict[str, str] = {}
    used: set[str] = set()
    for key, path in ordered:
        candidate = path
        counter = 2
        while candidate in used:
            stem, dot, suffix = path.rpartition(".")
            if not dot:
                stem, suffix = path, ""
            else:
                suffix = f".{suffix}"
            candidate = f"{stem}-{counter}{suffix}"
            counter += 1
        assigned[key] = candidate
        used.add(candidate)
    return assigned
