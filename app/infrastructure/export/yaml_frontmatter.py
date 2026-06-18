"""YAML frontmatter helpers for exports."""

from __future__ import annotations

from typing import Any


def _yaml_scalar(value: str) -> str:
    """Escape a string for YAML. Wrap in quotes if it contains special chars."""
    if not value:
        return '""'
    if "\n" in value:
        return "|\n" + "\n".join("  " + line for line in value.split("\n"))
    if any(c in value for c in [":", "#", "{", "}", "[", "]", ",", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`"]):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def _yaml_lines(value, indent: int = 0):
    """Yield YAML lines for a value at the given indentation level."""
    prefix = "  " * indent
    if value is None:
        yield prefix + "null"
    elif isinstance(value, bool):
        yield prefix + ("true" if value else "false")
    elif isinstance(value, (int, float)):
        yield prefix + str(value)
    elif isinstance(value, str):
        yield prefix + _yaml_scalar(value)
    elif isinstance(value, list):
        if not value:
            yield prefix + "[]"
        else:
            for item in value:
                if isinstance(item, (dict, list)) and item:
                    first = True
                    for line in _yaml_lines(item, indent + 1):
                        if first:
                            yield prefix + "- " + line[len(prefix + "  "):]
                            first = False
                        else:
                            yield line
                else:
                    scalar = (
                        _yaml_scalar(item)
                        if isinstance(item, str)
                        else "true"
                        if item is True
                        else "false"
                        if item is False
                        else "null"
                        if item is None
                        else str(item)
                    )
                    yield prefix + "- " + scalar
    elif isinstance(value, dict):
        if not value:
            yield prefix + "{}"
        else:
            for k, v in value.items():
                if isinstance(v, (dict, list)) and v:
                    yield prefix + k + ":"
                    for line in _yaml_lines(v, indent + 1):
                        yield line
                else:
                    scalar = (
                        _yaml_scalar(v)
                        if isinstance(v, str)
                        else "true"
                        if v is True
                        else "false"
                        if v is False
                        else "null"
                        if v is None
                        else str(v)
                    )
                    yield prefix + k + ": " + scalar
    else:
        yield prefix + str(value)


def build_yaml_frontmatter(data: dict[str, Any]) -> str:
    """Build a YAML frontmatter block from a dict."""
    lines = ["---"]
    for key, value in data.items():
        if isinstance(value, (dict, list)) and value:
            lines.append(key + ":")
            for line in _yaml_lines(value, 1):
                lines.append(line)
        else:
            scalar = (
                _yaml_scalar(value)
                if isinstance(value, str)
                else "true"
                if value is True
                else "false"
                if value is False
                else "null"
                if value is None
                else str(value)
            )
            lines.append(key + ": " + scalar)
    lines.append("---")
    return "\n".join(lines) + "\n\n"
