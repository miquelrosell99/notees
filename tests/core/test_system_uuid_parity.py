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
}

EXPECTED_PROPERTY_NAMES = {
    "attachments",
    "authors",
    "isbn",
    "doi",
    "publication_date",
    "publisher",
    "role",
    "locator",
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
