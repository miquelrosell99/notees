"""
Canonical AST ↔ string conversion for Notees (Python backend).

Two symmetrical entry points:

    ``stringify_ast(ast, options)``  – AST → readable string
    ``parse_ast(value, mode)``      – input → AST objects

``stringify_ast`` modes (closed enum — ``StringifyMode``):
    NODE_MARKDOWN   – preserves node semantics ([[…]], [label]([[…]]))
    PLAIN_MARKDOWN  – standard portable Markdown, no [[…]]
    TEXT_ONLY        – plain text for search / indexing

``parse_ast`` modes (closed enum — ``ParseMode``):
    JSON       – JSON string or list → validated AST (default)
    PLAIN      – wrap plain text as-is in a paragraph
    MARKDOWN   – parse inline Markdown (bold, italic, code, …)

Helper:
    ``serialize_ast(ast)``  – ``json.dumps`` shortcut for DB storage

Node links are resolved recursively with cycle detection.

Notees
Copyright (C) 2026 Miquel Rosell Tarragó
AGPL-3.0 – see LICENSE.
"""
from __future__ import annotations

import json
import re
from enum import Enum
from dataclasses import dataclass
from typing import (
    Any,
    Callable,
    List,
    Optional,
    Sequence,
    Set,
)

__all__ = [
    "StringifyMode",
    "ParseMode",
    "NodeLinkResolution",
    "NodeLinkResolver",
    "StringifyOptions",
    "stringify_ast",
    "parse_ast",
    "serialize_ast",
]


# ── Public types ────────────────────────────────────────────────────


class StringifyMode(str, Enum):
    """Closed enum of stringify modes (AST → string)."""

    NODE_MARKDOWN = "NODE_MARKDOWN"
    """Internal Markdown that preserves node semantics."""

    PLAIN_MARKDOWN = "PLAIN_MARKDOWN"
    """Standard Markdown without node semantics (for export)."""

    TEXT_ONLY = "TEXT_ONLY"
    """Plain text for search indexing."""


class ParseMode(str, Enum):
    """Closed enum of parse modes (string → AST)."""

    JSON = "JSON"
    """Deserialize a JSON string (or pass through a list). Default."""

    PLAIN = "PLAIN"
    """Wrap plain text as-is in a single text node (no formatting)."""

    MARKDOWN = "MARKDOWN"
    """Parse inline Markdown: **bold**, *italic*, `code`, ~~strike~~, ==highlight==, [text](url)."""


@dataclass(frozen=True, slots=True)
class NodeLinkResolution:
    """Result of resolving a node link."""

    target_ast: List[dict]
    """The target node's name AST."""

    label: Optional[str]
    """Fallback label (may be None; AST label takes precedence)."""

    target_id: str
    """Opaque node identifier for cycle detection."""

    is_page: Optional[bool] = None
    """Whether the target node is a page (True) or a block (False/None)."""


# Callable that takes a link_id (node_link UUID) and returns resolution or None.
NodeLinkResolver = Callable[[str], Optional[NodeLinkResolution]]


@dataclass(frozen=True, slots=True)
class StringifyOptions:
    """Options for stringify_ast."""

    mode: StringifyMode
    max_length: Optional[int] = None
    resolve_node_link: Optional[NodeLinkResolver] = None
    # When True (HTML export), node_link nodes emit [text](#target-uuid) so
    # _markdown_inline_to_html converts them to clickable <a> elements.
    html_anchors: bool = False

    # Internal — callers should NOT set this.
    _visited: frozenset[str] = frozenset()


# ── Entry point ─────────────────────────────────────────────────────


def stringify_ast(
    ast: Sequence[dict],
    options: StringifyOptions,
) -> str:
    """Stringify a complete AST document.

    Deterministic.  Side-effect-free.  No global state.
    """
    result = _render_document(list(ast), options)
    if options.max_length is not None and len(result) > options.max_length:
        return result[: options.max_length]
    return result


def parse_ast(value: Any, mode: ParseMode = ParseMode.JSON) -> List[dict]:
    """Parse input into a validated AST document.

    Modes:
        JSON (default):
            - JSON string → parse → validate
            - list         → validate
            - anything else → empty document
        PLAIN:
            - Wrap text as-is in ``[{paragraph: [{text: value}]}]``
            - Empty / None → empty document
        MARKDOWN:
            - Parse inline Markdown formatting into AST nodes
            - Supports: **bold**, *italic*, `code`, ~~strike~~,
              ==highlight==, [text](url)
            - Empty / None → empty document
    """
    if mode is ParseMode.JSON:
        return _parse_json(value)

    # PLAIN and MARKDOWN both need a string
    if not isinstance(value, str) or not value:
        return []

    if mode is ParseMode.PLAIN:
        return [{"type": "paragraph", "children": [{"type": "text", "text": value}]}]

    # MARKDOWN
    return _parse_markdown(value)


def serialize_ast(ast: List[dict]) -> str:
    """Serialize an AST document to a JSON string for DB storage.

    This is a thin wrapper around ``json.dumps`` that pairs with
    ``parse_ast(..., ParseMode.JSON)`` for deserialization.
    """
    return json.dumps(ast)


# ── Document / block rendering ─────────────────────────────────────


def _render_document(blocks: List[dict], opts: StringifyOptions) -> str:
    if not blocks:
        return ""

    is_text = opts.mode is StringifyMode.TEXT_ONLY
    rendered = [_render_block(b, opts) for b in blocks]

    if is_text:
        return _collapse_whitespace(" ".join(rendered))

    return "\n\n".join(rendered)


def _render_block(block: dict, opts: StringifyOptions) -> str:
    block_type = block.get("type")
    if block_type == "paragraph":
        return _render_inline_sequence(block.get("children", []), opts)
    # Unknown block type — stable placeholder.
    return ""


# ── Inline rendering ───────────────────────────────────────────────


def _render_inline_sequence(nodes: List[dict], opts: StringifyOptions) -> str:
    return "".join(_render_inline(n, opts) for n in nodes)


def _render_inline(node: dict, opts: StringifyOptions) -> str:
    node_type = node.get("type")
    mode = opts.mode
    is_text = mode is StringifyMode.TEXT_ONLY

    if node_type == "text":
        return node.get("text", "")

    if node_type == "hard_break":
        return " " if is_text else "  \n"

    if node_type == "strong":
        inner = _render_inline_sequence(node.get("children", []), opts)
        return inner if is_text else f"**{inner}**"

    if node_type == "em":
        inner = _render_inline_sequence(node.get("children", []), opts)
        return inner if is_text else f"*{inner}*"

    if node_type == "code":
        t = node.get("text", "")
        return t if is_text else f"`{t}`"

    if node_type == "strikethrough":
        inner = _render_inline_sequence(node.get("children", []), opts)
        return inner if is_text else f"~~{inner}~~"

    if node_type == "highlight":
        inner = _render_inline_sequence(node.get("children", []), opts)
        return inner if is_text else f"=={inner}=="

    if node_type == "underline":
        inner = _render_inline_sequence(node.get("children", []), opts)
        return inner if is_text else f"<u>{inner}</u>"

    if node_type == "external_link":
        link_text = _render_inline_sequence(node.get("children", []), opts)
        if is_text:
            return link_text
        url = node.get("url", "")
        return f"[{link_text}]({url})"

    if node_type == "node_link":
        link_id = node.get("link_id", "")
        ref_type = node.get("ref_type", "node")
        ast_label = node.get("label") or None
        return _render_node_link(link_id, ref_type, opts, ast_label=ast_label)

    # Unknown inline node — ignore silently.
    return ""


# ── Node link rendering ────────────────────────────────────────────


def _render_node_link(link_id: str, ref_type: str, opts: StringifyOptions, *, ast_label: str | None = None) -> str:
    """Render a node_link AST node according to the current mode.

    NODE_MARKDOWN:
        Without label: ``[[resolved_text]]``
        With label:    ``[label]([[resolved_text]])``

    PLAIN_MARKDOWN / TEXT_ONLY:
        label if present, otherwise resolved node text.

    AST label takes precedence over the resolution (DB) label.
    Cycle-safe: if the target was already visited, emits "…".
    """
    resolver = opts.resolve_node_link
    placeholder_md = "[[…]]" if opts.mode is StringifyMode.NODE_MARKDOWN else "…"

    if resolver is None:
        # No resolver — use AST label if available
        if ast_label:
            if opts.mode is StringifyMode.NODE_MARKDOWN:
                if ref_type == "class":
                    return ast_label
                return f"[{ast_label}]([[{link_id}]])"
            return ast_label
        return placeholder_md

    resolution = resolver(link_id)
    if resolution is None:
        if ast_label:
            if opts.mode is StringifyMode.NODE_MARKDOWN:
                if ref_type == "class":
                    return ast_label
                return f"[{ast_label}]([[{link_id}]])"
            return ast_label
        return placeholder_md

    target_ast, label, target_id = (
        resolution.target_ast,
        ast_label if ast_label is not None else resolution.label,
        resolution.target_id,
    )

    # ── Cycle detection ──
    if target_id in opts._visited:
        return placeholder_md

    child_opts = StringifyOptions(
        mode=opts.mode,
        max_length=opts.max_length,
        resolve_node_link=opts.resolve_node_link,
        html_anchors=opts.html_anchors,
        _visited=opts._visited | {target_id},
    )

    resolved_text = stringify_ast(target_ast, child_opts)

    if opts.mode is StringifyMode.NODE_MARKDOWN:
        if ref_type == "class":
            return label if label else f"{{{{{resolved_text}}}}}"
        # Node references
        if label:
            return f"[{label}]([[{resolved_text}]])"
        return f"[[{resolved_text}]]"

    # PLAIN_MARKDOWN / TEXT_ONLY
    display = label if label else resolved_text
    if opts.html_anchors and opts.mode is StringifyMode.PLAIN_MARKDOWN:
        # Extract target node UUID from link_id (format: "targetUUID:linkUUID")
        colon = link_id.find(':')
        target_uuid = link_id[:colon] if colon > 0 else link_id
        if target_uuid:
            return f"[{display}](#{target_uuid})"
    if opts.mode is StringifyMode.PLAIN_MARKDOWN:
        # Markdown export: [name]([[uuid]]) for all node links
        colon = link_id.find(':')
        target_uuid = link_id[:colon] if colon > 0 else link_id
        return f"[{display}]([[{target_uuid}]])"
    return display


# ── parse_ast helpers ───────────────────────────────────────────────


def _parse_json(value: Any) -> List[dict]:
    """Parse a JSON string or list into a validated AST document."""
    if isinstance(value, str):
        if not value:
            return []
        try:
            parsed = json.loads(value)
            if not isinstance(parsed, list):
                return []
            return _validate_document(parsed)
        except (json.JSONDecodeError, TypeError):
            return []
    if isinstance(value, list):
        return _validate_document(value)
    return []


# ── Markdown inline patterns ───────────────────────────────────────
#
# We parse a flat string into inline AST nodes.  The grammar handles:
#     **bold**  *italic*  `code`  ~~strikethrough~~  ==highlight==
#     [link text](url)
#
# Nesting (e.g. **bold *and italic***) is supported one level deep.

_MD_INLINE_RE = re.compile(
    r"(?P<code>`[^`]+`)"                   # `code`
    r"|(?P<bold_italic>\*\*\*(?P<bi>.+?)\*\*\*)"  # ***bold italic***
    r"|(?P<bold>\*\*(?P<b>.+?)\*\*)"       # **bold**
    r"|(?P<italic>\*(?P<i>[^*]+?)\*)"       # *italic*
    r"|(?P<strike>~~(?P<s>.+?)~~)"          # ~~strike~~
    r"|(?P<highlight>==(?P<h>.+?)==)"        # ==highlight==
    r"|(?P<link>\[(?P<lt>[^\]]+)\]\((?P<lu>[^)]+)\))"  # [text](url)
)


def _parse_markdown(text: str) -> List[dict]:
    """Parse inline Markdown into an AST document (one paragraph)."""
    children = _parse_md_inline(text)
    if not children:
        return []
    return [{"type": "paragraph", "children": children}]


def _parse_md_inline(text: str) -> List[dict]:
    """Parse inline Markdown patterns into a list of AST inline nodes."""
    nodes: List[dict] = []
    pos = 0

    for m in _MD_INLINE_RE.finditer(text):
        start, end = m.start(), m.end()

        # Emit plain text before this match
        if start > pos:
            nodes.append({"type": "text", "text": text[pos:start]})

        if m.group("code"):
            raw = m.group("code")
            nodes.append({"type": "code", "text": raw[1:-1]})

        elif m.group("bold_italic"):
            inner = m.group("bi")
            nodes.append({"type": "strong", "children": [
                {"type": "em", "children": [{"type": "text", "text": inner}]}
            ]})

        elif m.group("bold"):
            inner = m.group("b")
            nodes.append({"type": "strong", "children": _parse_md_inline(inner)})

        elif m.group("italic"):
            inner = m.group("i")
            nodes.append({"type": "em", "children": _parse_md_inline(inner)})

        elif m.group("strike"):
            inner = m.group("s")
            nodes.append({"type": "strikethrough", "children": _parse_md_inline(inner)})

        elif m.group("highlight"):
            inner = m.group("h")
            nodes.append({"type": "highlight", "children": _parse_md_inline(inner)})

        elif m.group("link"):
            link_text = m.group("lt")
            url = m.group("lu")
            nodes.append({"type": "external_link", "url": url, "children": [
                {"type": "text", "text": link_text}
            ]})

        pos = end

    # Trailing text
    if pos < len(text):
        nodes.append({"type": "text", "text": text[pos:]})

    return nodes


# ── Utilities ───────────────────────────────────────────────────────

_WS_RE = re.compile(r"\s+")


def _collapse_whitespace(s: str) -> str:
    return _WS_RE.sub(" ", s).strip()


def _validate_document(doc: Any) -> List[dict]:
    """Shallow validation — each element must be a dict with ``type``."""
    if not isinstance(doc, list):
        return []
    for block in doc:
        if not isinstance(block, dict) or "type" not in block:
            return []
    return doc
