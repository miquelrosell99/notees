"""Parity test for the mirrored system-UUID registries.

System classes and system properties are identified by fixed, well-known
UUIDs hardcoded in two mirrored maps:

- backend:  ``app/domain/entities/constants.py``
- frontend: ``frontend/src/constants/systemProperties.ts``

These maps must never drift: both derived stores replay the same op log, so
a UUID that exists on one side only (or with a different value) silently
breaks sync, seeds, and queries. This test parses both files and fails if
the class maps or the property maps differ in keys or values.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_CONSTANTS = REPO_ROOT / "app" / "domain" / "entities" / "constants.py"
FRONTEND_CONSTANTS = REPO_ROOT / "frontend" / "src" / "constants" / "systemProperties.ts"

# Matches `name: 'uuid'` (TS) and `"name": "uuid"` (Python) entries.
_ENTRY_RE = re.compile(r"[\"']?(\w+)[\"']?\s*:\s*[\"']([0-9a-fA-F-]{36})[\"']")

EXPECTED_CLASS_NAMES = {
    "source",
    "book",
    "paper",
    "article",
    "thesis",
    "document",
    "agent",
    "person",
    "organization",
    "collection",
    "highlight",
    "movie",
}

EXPECTED_PROPERTY_NAMES = {
    "attachments",
    "authors",
    "isbn",
    "doi",
    "publication_date",
    "publisher",
    "role",
    "provenance",
    "highlight_asset",
    "given_name",
    "family_name",
    "citekey",
}


def _parse_map(path: Path, map_name: str) -> dict[str, str]:
    """Extract the ``name -> uuid`` entries of one map from a constants file."""
    text = path.read_text(encoding="utf-8")
    block_match = re.search(rf"{map_name}\s*=\s*\{{(.*?)\n\}}", text, re.DOTALL)
    assert block_match, f"{map_name} not found in {path}"
    entries = dict(_ENTRY_RE.findall(block_match.group(1)))
    assert entries, f"no UUID entries parsed from {map_name} in {path}"
    return entries


def _backend_map(map_name: str) -> dict[str, str]:
    return _parse_map(BACKEND_CONSTANTS, map_name)


def _frontend_map(map_name: str) -> dict[str, str]:
    return _parse_map(FRONTEND_CONSTANTS, map_name)


def _parse_ts_object_literal(path: Path, name: str) -> object:
    """Parse a ``const NAME = { ... }`` literal from a TS file.

    The mirrored constants only contain strings, numbers, booleans, lists and
    dicts, so the literal can be evaluated with :func:`ast.literal_eval` after
    quoting bare keys and translating JS primitives.
    """
    text = path.read_text(encoding="utf-8")
    start = re.search(rf"\b{name}\s*[:=]", text)
    assert start, f"{name} not found in {path}"
    brace = text.index("{", start.end() - 1)
    depth = 0
    end = -1
    for i in range(brace, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    assert end > 0, f"unbalanced braces parsing {name} in {path}"
    block = text[brace:end]
    block = re.sub(r"//[^\n]*", "", block)
    block = re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r"\1'\2':", block)
    block = re.sub(r"\btrue\b", "True", block)
    block = re.sub(r"\bfalse\b", "False", block)
    block = re.sub(r"\bnull\b", "None", block)
    block = re.sub(r",(\s*[}\]])", r"\1", block)
    return ast.literal_eval(block)


def _frontend_constant(name: str) -> object:
    return _parse_ts_object_literal(FRONTEND_CONSTANTS, name)


def test_system_class_uuids_parity() -> None:
    backend = _backend_map("SYSTEM_CLASS_UUIDS")
    frontend = _frontend_map("SYSTEM_CLASS_UUIDS")
    assert backend == frontend, (
        "SYSTEM_CLASS_UUIDS drift between backend and frontend:\n"
        f"only in backend: {sorted(set(backend) - set(frontend))}\n"
        f"only in frontend: {sorted(set(frontend) - set(backend))}\n"
        f"value mismatches: {sorted(k for k in backend.keys() & frontend.keys() if backend[k] != frontend[k])}"
    )


def test_system_property_uuids_parity() -> None:
    backend = _backend_map("SYSTEM_PROPERTY_UUIDS")
    frontend = _frontend_map("SYSTEM_PROPERTY_UUIDS")
    assert backend == frontend, (
        "SYSTEM_PROPERTY_UUIDS drift between backend and frontend:\n"
        f"only in backend: {sorted(set(backend) - set(frontend))}\n"
        f"only in frontend: {sorted(set(frontend) - set(backend))}\n"
        f"value mismatches: {sorted(k for k in backend.keys() & frontend.keys() if backend[k] != frontend[k])}"
    )


def test_source_hierarchy_classes_registered() -> None:
    """The Task 2 source/agent/highlight classes exist on both sides."""
    assert EXPECTED_CLASS_NAMES.issubset(_backend_map("SYSTEM_CLASS_UUIDS"))
    assert EXPECTED_CLASS_NAMES.issubset(_frontend_map("SYSTEM_CLASS_UUIDS"))


def test_source_hierarchy_properties_registered() -> None:
    """The Task 2 attachment/bibliographic properties exist on both sides."""
    assert EXPECTED_PROPERTY_NAMES.issubset(_backend_map("SYSTEM_PROPERTY_UUIDS"))
    assert EXPECTED_PROPERTY_NAMES.issubset(_frontend_map("SYSTEM_PROPERTY_UUIDS"))


def test_system_class_icons_parity() -> None:
    """SYSTEM_CLASS_ICONS must not drift between backend and frontend."""
    from app.domain.entities.constants import SYSTEM_CLASS_ICONS

    frontend = _frontend_constant("SYSTEM_CLASS_ICONS")
    assert dict(SYSTEM_CLASS_ICONS) == frontend


def test_system_class_extends_parity() -> None:
    """SYSTEM_CLASS_EXTENDS must not drift between backend and frontend."""
    from app.domain.entities.constants import SYSTEM_CLASS_EXTENDS

    frontend = _frontend_constant("SYSTEM_CLASS_EXTENDS")
    assert {k: list(v) for k, v in SYSTEM_CLASS_EXTENDS.items()} == frontend


def test_system_property_schema_specs_parity() -> None:
    """SYSTEM_PROPERTY_SCHEMA_SPECS must not drift between backend and frontend."""
    from app.domain.entities.constants import SYSTEM_PROPERTY_SCHEMA_SPECS

    frontend = _frontend_constant("SYSTEM_PROPERTY_SCHEMA_SPECS")
    assert {k: dict(v) for k, v in SYSTEM_PROPERTY_SCHEMA_SPECS.items()} == frontend


def test_system_extra_class_bindings_parity() -> None:
    """SYSTEM_EXTRA_CLASS_BINDINGS must not drift between backend and frontend."""
    from app.domain.entities.constants import SYSTEM_EXTRA_CLASS_BINDINGS

    frontend = _frontend_constant("SYSTEM_EXTRA_CLASS_BINDINGS")
    assert {k: dict(v) for k, v in SYSTEM_EXTRA_CLASS_BINDINGS.items()} == frontend
