"""Pattern-driven citekey generation.

Pure functions implementing the workspace-level ``citekey_pattern`` setting
(Decision 8): tokens ``family_name``/``organization_name``/``year``/
``title_word`` with optional ``:lower``/``:upper`` modifiers, unresolved-token
fallback to a title-derived word and then ``untitled``, and deterministic
letter-suffix collision resolution (``herbert1965`` → ``herbert1965a`` →
``herbert1965b``).

Generation is a pure default: callers fill the ``citekey`` property only when
it is empty and never recompute or overwrite a stored key. Changing the
pattern therefore affects only future generations.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

DEFAULT_CITEKEY_PATTERN = "{family_name:lower}{year}"

# Leading stop words skipped when deriving a title word, mirroring Better
# BibTeX behaviour so "The Dune Encyclopedia" yields "dune", not "the".
STOP_WORDS = {
    "a",
    "an",
    "the",
    "and",
    "or",
    "of",
    "on",
    "in",
    "de",
    "der",
    "den",
    "la",
    "le",
    "el",
    "los",
    "las",
}

_TOKEN_RE = re.compile(r"\{([A-Za-z_]+)(?::(lower|upper))?\}")
_WORD_RE = re.compile(r"\w+", re.UNICODE)
_NON_KEY_CHARS_RE = re.compile(r"[^\w-]", re.UNICODE)
_YEAR_RE = re.compile(r"\b(\d{4})\b")


def first_title_word(title: str | None) -> str | None:
    """Return the first significant word of ``title`` (stop words skipped)."""
    if not title:
        return None
    for word in _WORD_RE.findall(title):
        if word.lower() not in STOP_WORDS:
            return word
    return None


def extract_year(date_text: str | None) -> str | None:
    """Return the first four-digit year found in a free-form date string."""
    if not date_text:
        return None
    match = _YEAR_RE.search(date_text)
    return match.group(1) if match else None


def _slug(value: str) -> str:
    """Strip characters that are not allowed in a citekey segment."""
    return _NON_KEY_CHARS_RE.sub("", value)


def render_citekey_pattern(
    pattern: str,
    *,
    family_name: str | None = None,
    organization_name: str | None = None,
    year: str | None = None,
    title: str | None = None,
) -> str:
    """Render a citekey pattern against source metadata.

    Supported tokens: ``{family_name}``, ``{organization_name}``, ``{year}``,
    ``{title_word}``, each with optional ``:lower``/``:upper`` modifiers.
    Tokens that cannot be resolved (including unknown token names) fall back
    to the first significant title word, then to ``untitled``. Literal text
    outside tokens is preserved verbatim. Identical adjacent fallback
    segments collapse into one, so a fully unresolvable pattern yields
    ``untitled`` rather than ``untitleduntitled``.
    """
    title_word = first_title_word(title)
    token_values = {
        "family_name": family_name,
        "organization_name": organization_name,
        "year": year,
        "title_word": title_word,
    }
    fallback = title_word if title_word else "untitled"
    emitted: list[str] = []
    last_fallback: str | None = None
    last_end = 0

    for match in _TOKEN_RE.finditer(pattern):
        literal = pattern[last_end : match.start()]
        if literal:
            emitted.append(literal)
            last_fallback = None
        last_end = match.end()

        token, modifier = match.group(1), match.group(2)
        value = token_values.get(token)
        is_fallback = not value
        if is_fallback:
            value = fallback
        slug = _slug(value)
        if not slug:
            slug, is_fallback = "untitled", True
        if modifier == "lower":
            slug = slug.lower()
        elif modifier == "upper":
            slug = slug.upper()
        if is_fallback and slug == last_fallback:
            continue
        emitted.append(slug)
        last_fallback = slug if is_fallback else None

    emitted.append(pattern[last_end:])
    return "".join(emitted)


def _letter_suffix(n: int) -> str:
    """Return the collision suffix for attempt ``n``: "", "a", "b", …, "z", "aa", …"""
    if n == 0:
        return ""
    letters = ""
    n -= 1
    while True:
        letters = chr(ord("a") + n % 26) + letters
        n = n // 26 - 1
        if n < 0:
            return letters


def resolve_citekey_collision(base: str, existing: Iterable[str]) -> str:
    """Return ``base`` or the first free letter-suffixed variant.

    Deterministic: given the same ``base`` and the same set of existing keys,
    the result is always the same (``herbert1965`` → ``herbert1965a`` →
    ``herbert1965b``).
    """
    taken = set(existing)
    attempt = 0
    while True:
        candidate = f"{base}{_letter_suffix(attempt)}"
        if candidate not in taken:
            return candidate
        attempt += 1


def generate_citekey(
    pattern: str | None = None,
    *,
    creators: list[dict[str, str]] | None = None,
    publication_date: str | None = None,
    title: str | None = None,
    existing: Iterable[str] = (),
) -> str:
    """Generate a collision-free citekey for a source.

    ``creators`` carries pre-extracted creator metadata dicts with
    ``family_name`` (persons) and/or ``organization_name`` (organizations)
    keys; the first available value of each kind feeds the corresponding
    token. ``existing`` is the set of citekeys already in use in the
    workspace; the returned key is guaranteed not to be in it.
    """
    creators = creators or []
    family_name = next((c["family_name"] for c in creators if c.get("family_name")), None)
    organization_name = next(
        (c["organization_name"] for c in creators if c.get("organization_name")),
        None,
    )
    effective_pattern = pattern if pattern and pattern.strip() else DEFAULT_CITEKEY_PATTERN
    base = render_citekey_pattern(
        effective_pattern,
        family_name=family_name,
        organization_name=organization_name,
        year=extract_year(publication_date),
        title=title,
    )
    if not base.strip():
        base = "untitled"
    return resolve_citekey_collision(base, existing)
