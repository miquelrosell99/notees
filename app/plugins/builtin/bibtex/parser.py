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


def parse_bibtex(content: str) -> list[BibEntry]:
    """Parse a BibTeX string into entries."""
    entries: list[BibEntry] = []
    # Remove comments and normalize whitespace.
    cleaned = re.sub(r"%.*?\n", "\n", content)
    # Match @type{citekey, ... } blocks (non-nested).
    for match in re.finditer(r"@(\w+)\s*\{\s*([^,\s]+)\s*,([^}]*)\}", cleaned, re.DOTALL):
        entry_type = match.group(1).lower()
        cite_key = match.group(2).strip()
        body = match.group(3)
        fields: dict[str, str] = {}
        for field_match in re.finditer(r"(\w+)\s*=\s*\{([^}]*)\}", body):
            key = field_match.group(1).lower()
            value = _unlatex(field_match.group(2))
            fields[key] = value
        entries.append(BibEntry(cite_key=cite_key, entry_type=entry_type, fields=fields))
    return entries


def _unlatex(value: str) -> str:
    """Remove simple LaTeX escapes."""
    value = re.sub(r"\\'([a-zA-Z])", r"\1", value)
    value = re.sub(r'\\"([a-zA-Z])', r"\1", value)
    value = re.sub(r"\\([a-zA-Z]+)\{([^}]*)\}", r"\2", value)
    value = value.replace("{", "").replace("}", "")
    return value.strip()


def serialize_bibtex(entries: list[BibEntry]) -> str:
    """Serialize entries to a BibTeX string."""
    lines: list[str] = []
    for entry in entries:
        lines.append(f"@{entry.entry_type}{{{entry.cite_key},")
        for key, value in entry.fields.items():
            lines.append(f"  {key} = {{{value}}},")
        lines.append("}")
        lines.append("")
    return "\n".join(lines)
