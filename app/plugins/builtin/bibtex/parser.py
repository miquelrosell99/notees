"""Minimal BibTeX parser."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class BibEntry:
    """Parsed BibTeX entry."""

    cite_key: str
    entry_type: str
    fields: dict[str, str] = field(default_factory=dict)

    @property
    def title(self) -> str:
        return self.fields.get("title", "")

    @property
    def author(self) -> str:
        return self.fields.get("author", "")

    @property
    def year(self) -> str:
        return self.fields.get("year", "")

    @property
    def publication_date(self) -> str:
        """Free-form publication date (``date`` field, else ``year``)."""
        return self.fields.get("date", "") or self.fields.get("year", "")

    @property
    def doi(self) -> str:
        return self.fields.get("doi", "")

    @property
    def url(self) -> str:
        return self.fields.get("url", "")

    @property
    def isbn(self) -> str:
        return self.fields.get("isbn", "")

    @property
    def publisher(self) -> str:
        return self.fields.get("publisher", "")


def parse_authors(value: str) -> list[dict[str, str]]:
    """Parse a BibTeX ``author`` field into normalized creator dicts.

    Follows BibTeX name rules: ``"Last, First"`` splits on the comma;
    ``"First Last"`` treats the last word as the family name; a single word
    becomes a family name only. Corporate authors should use BibTeX's
    double-brace form to survive as one unit — since the parser strips
    braces, comma-less multi-word names are always treated as persons.
    """
    creators: list[dict[str, str]] = []
    for part in re.split(r"\s+and\s+", value):
        name = part.strip()
        if not name:
            continue
        if "," in name:
            family, given = (piece.strip() for piece in name.split(",", 1))
            creators.append({"given_name": given, "family_name": family})
            continue
        words = name.split()
        if len(words) == 1:
            creators.append({"given_name": "", "family_name": words[0]})
        else:
            creators.append(
                {"given_name": " ".join(words[:-1]), "family_name": words[-1]}
            )
    return creators


def parse_bibtex(content: str) -> list[BibEntry]:
    """Parse a BibTeX string into entries."""
    entries: list[BibEntry] = []
    # Remove comments.
    cleaned = re.sub(r"%.*?\n", "\n", content)
    # Match entry headers, then brace-count to find the entry body so that
    # field values containing braces do not terminate the entry early.
    for match in re.finditer(r"@(\w+)\s*\{\s*([^,\s]+)\s*,", cleaned):
        entry_type = match.group(1).lower()
        if entry_type in ("comment", "preamble", "string"):
            continue
        cite_key = match.group(2).strip()
        body = _balanced_block(cleaned, match.end())
        entries.append(
            BibEntry(
                cite_key=cite_key,
                entry_type=entry_type,
                fields=_parse_fields(body),
            )
        )
    return entries


def _balanced_block(text: str, start: int) -> str:
    """Return the text up to the closing brace that balances ``{`` at depth 1."""
    depth = 1
    i = start
    while i < len(text) and depth:
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
        i += 1
    return text[start : i - 1]


def _parse_fields(body: str) -> dict[str, str]:
    """Parse ``key = {value}`` / ``key = "value"`` / ``key = 1234`` fields."""
    fields: dict[str, str] = {}
    for match in re.finditer(r"(\w+)\s*=\s*", body):
        key = match.group(1).lower()
        i = match.end()
        if i < len(body) and body[i] == "{":
            value = _balanced_block(body, i + 1)
        elif i < len(body) and body[i] == '"':
            end = body.find('"', i + 1)
            value = body[i + 1 : end if end != -1 else len(body)]
        else:
            bare = re.match(r"[^,]+", body[i:])
            value = bare.group(0) if bare else ""
        fields[key] = _unlatex(value)
    return fields


def _unlatex(value: str) -> str:
    """Remove simple LaTeX escapes."""
    value = re.sub(r"\\'([a-zA-Z])", r"\1", value)
    value = re.sub(r'\\"([a-zA-Z])', r"\1", value)
    value = re.sub(r"\\([a-zA-Z]+)\{([^}]*)\}", r"\2", value)
    value = value.replace("{", "").replace("}", "")
    return value.strip()
