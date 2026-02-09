"""
Canonical AST → string stringifier for Notees (Python backend).

ONE function — ``stringify_ast`` — controlled ONLY by ``StringifyMode``.
No other stringifier may exist on the backend.

Modes (closed enum):
    NODE_MARKDOWN   – preserves node semantics ([[…]], [label]([[…]]))
    PLAIN_MARKDOWN  – standard portable Markdown, no [[…]]
    TEXT_ONLY        – plain text for search / indexing

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
    "NodeLinkResolution",
    "NodeLinkResolver",
    "StringifyOptions",
    "stringify_ast",
    "parse_ast",
]


# ── Public types ────────────────────────────────────────────────────


class StringifyMode(str, Enum):
    """Closed enum of stringify modes."""

    NODE_MARKDOWN = "NODE_MARKDOWN"
    """Internal Markdown that preserves node semantics."""

    PLAIN_MARKDOWN = "PLAIN_MARKDOWN"
    """Standard Markdown without node semantics (for export)."""

    TEXT_ONLY = "TEXT_ONLY"
    """Plain text for search indexing."""


@dataclass(frozen=True, slots=True)
class NodeLinkResolution:
    """Result of resolving a node link."""

    target_ast: List[dict]
    """The target node's name AST."""

    label: Optional[str]
    """Custom label from node_link.name (may be None)."""

    target_id: str
    """Opaque node identifier for cycle detection."""


# Callable that takes a link_id (node_link UUID) and returns resolution or None.
NodeLinkResolver = Callable[[str], Optional[NodeLinkResolution]]


@dataclass(frozen=True, slots=True)
class StringifyOptions:
    """Options for stringify_ast."""

    mode: StringifyMode
    max_length: Optional[int] = None
    resolve_node_link: Optional[NodeLinkResolver] = None

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


def parse_ast(value: Any) -> List[dict]:
    """Parse a ``name`` column value into a validated AST document.

    - JSON string → parse → validate
    - list        → validate
    - anything else → empty document
    """
    if isinstance(value, str):
        if not value:
            return []
        try:
            parsed = json.loads(value)
            return _validate_document(parsed)
        except (json.JSONDecodeError, TypeError):
            return []
    if isinstance(value, list):
        return _validate_document(value)
    return []


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

    if node_type == "external_link":
        link_text = _render_inline_sequence(node.get("children", []), opts)
        if is_text:
            return link_text
        url = node.get("url", "")
        return f"[{link_text}]({url})"

    if node_type == "node_link":
        link_id = node.get("link_id", "")
        ref_type = node.get("ref_type", "node")
        return _render_node_link(link_id, ref_type, opts)

    # Unknown inline node — ignore silently.
    return ""


# ── Node link rendering ────────────────────────────────────────────


def _render_node_link(link_id: str, ref_type: str, opts: StringifyOptions) -> str:
    """Render a node_link AST node according to the current mode.

    NODE_MARKDOWN:
        Without label: ``[[resolved_text]]``
        With label:    ``[label]([[resolved_text]])``

    PLAIN_MARKDOWN / TEXT_ONLY:
        label if present, otherwise resolved node text.

    Cycle-safe: if the target was already visited, emits "…".
    """
    resolver = opts.resolve_node_link
    placeholder_md = "[[…]]" if opts.mode is StringifyMode.NODE_MARKDOWN else "…"

    if resolver is None:
        return placeholder_md

    resolution = resolver(link_id)
    if resolution is None:
        return placeholder_md

    target_ast, label, target_id = (
        resolution.target_ast,
        resolution.label,
        resolution.target_id,
    )

    # ── Cycle detection ──
    if target_id in opts._visited:
        return placeholder_md

    child_opts = StringifyOptions(
        mode=opts.mode,
        max_length=opts.max_length,
        resolve_node_link=opts.resolve_node_link,
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
    return label if label else resolved_text


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
