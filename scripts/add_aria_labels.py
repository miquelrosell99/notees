#!/usr/bin/env python3
"""Add aria-label to icon-only Button components that have title but no aria-label.

One-off migration for the fleet accessibility audit. Review the diff before committing.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "frontend" / "src"


def find_button_tags(content: str) -> list[tuple[int, int, str]]:
    """Return a list of (start, end, attrs) for each <Button ...> or <Button .../> tag.

    Handles `>` characters inside JSX expression braces. Excludes type names like ButtonHTMLAttributes.
    """
    tags: list[tuple[int, int, str]] = []
    i = 0
    while True:
        start = content.find("<Button", i)
        if start == -1:
            break
        # Ensure this is an actual JSX element, not a type name like ButtonHTMLAttributes
        next_char = content[start + len("<Button")] if start + len("<Button") < len(content) else ""
        if next_char.isalnum() or next_char == "_":
            i = start + 1
            continue
        # Find the end of the tag, tracking brace depth
        j = start + len("<Button")
        brace_depth = 0
        while j < len(content):
            ch = content[j]
            if ch == "{":
                brace_depth += 1
            elif ch == "}":
                brace_depth -= 1
            elif ch == ">" and brace_depth == 0:
                end = j + 1
                attrs = content[start + len("<Button") : j]
                tags.append((start, end, attrs))
                break
            j += 1
        i = start + 1
    return tags


def is_icon_only(attrs: str) -> bool:
    """Heuristic: has icon= and no children (self-closing)."""
    return re.search(r"\bicon\s*=", attrs) is not None and attrs.strip().endswith("/")


def get_attr(attrs: str, name: str) -> str | None:
    """Extract a string or expression attribute value."""
    # String form: name="value" (value may contain escaped quotes)
    m = re.search(rf"\b{name}\s*=\"([^\"]*)\"", attrs)
    if m:
        return m.group(1)
    # Expression form: name={value}
    m = re.search(rf"\b{name}\s*=\{{([^}}]*)\}}", attrs)
    if m:
        return m.group(1).strip().strip('"').strip("'")
    return None


def has_attr(attrs: str, name: str) -> bool:
    return re.search(rf"\b{name}\b", attrs) is not None


def process_file(path: Path) -> int:
    content = path.read_text(encoding="utf-8")
    original = content

    for start, end, attrs in reversed(find_button_tags(content)):
        if not is_icon_only(attrs):
            continue
        if has_attr(attrs, "aria-label"):
            continue
        title = get_attr(attrs, "title")
        if not title:
            continue
        # Insert aria-label right after "<Button"
        insert_pos = start + len("<Button")
        content = content[:insert_pos] + f' aria-label="{title}"' + content[insert_pos:]

    if content != original:
        path.write_text(content, encoding="utf-8")
        return 1
    return 0


def main() -> None:
    changed = 0
    for path in sorted(ROOT.rglob("*.tsx")):
        if process_file(path):
            print(f"Updated: {path.relative_to(ROOT.parent)}")
            changed += 1
    print(f"Updated {changed} files.")


if __name__ == "__main__":
    main()
