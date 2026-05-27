"""Node converters for exporting nodes to various text formats.

Provides:
- NodeConverter protocol
- MarkdownConverter  – exports nodes as Markdown with YAML frontmatter support
- PlainTextConverter – exports nodes as plain text
- JsonAstConverter   – exports nodes as JSON AST
"""

from __future__ import annotations

from typing import Any, Protocol

from .json_ast_converter import JsonAstConverter
from .markdown_converter import MarkdownConverter
from .plain_text_converter import PlainTextConverter

__all__ = [
    "NodeConverter",
    "MarkdownConverter",
    "PlainTextConverter",
    "JsonAstConverter",
]


class NodeConverter(Protocol):
    """Protocol for node export converters."""

    def convert(
        self,
        nodes: list[dict[str, Any]],
        resolver=None,
        layout: str = "outline",
        formatting: bool = True,
        properties_data: dict[str, list] | None = None,
        strip_link_syntax: bool = False,
        code_class_id: int | None = None,
        quote_class_id: int | None = None,
        callout_class_map: dict[int, str] | None = None,
    ) -> str:
        """Convert a list of nodes to the target format.

        Args:
            nodes: List of node dicts with keys like uuid, name, is_page,
                   depth, color, class_ids, and optionally _ast.
            resolver: Optional node link resolver function.
            layout: "outline" or "flat".
            formatting: Whether to preserve rich text formatting.
            properties_data: Optional dict mapping node UUID to property entries.
            strip_link_syntax: Whether to strip link syntax (text only).
            code_class_id: Integer class ID for code blocks.
            quote_class_id: Integer class ID for quote blocks.
            callout_class_map: Dict mapping class ID to callout type string.

        Returns:
            The formatted string output.
        """
        ...
