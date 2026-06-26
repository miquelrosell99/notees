"""YAML frontmatter helpers for exports."""

from __future__ import annotations

from io import StringIO
from typing import Any

import yaml


def build_yaml_frontmatter(data: dict[str, Any]) -> str:
    """Build a YAML frontmatter block from a dict using PyYAML.

    Output is deterministic: mapping order is preserved, Unicode is emitted
    verbatim, and block scalars are used when PyYAML chooses them.
    """
    buffer = StringIO()
    yaml.safe_dump(
        data,
        buffer,
        default_flow_style=False,
        sort_keys=False,
        allow_unicode=True,
        explicit_start=False,
        explicit_end=False,
    )
    body = buffer.getvalue().rstrip("\n")
    if body:
        return f"---\n{body}\n---\n\n"
    return "---\n---\n\n"
