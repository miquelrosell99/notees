#!/usr/bin/env python3
"""Legacy v1 content AST -> flat v2 token stream.

Python port of the reference implementation in the Flutter client
`notees-flutter/lib/core/utils/ast_stringifier.dart` (B2 normalizeContentAst)
with the class-name normalization from v1 `app/core/derived/class.py`
(`_normalize_class_name`). Keep the semantics identical:

- unwrapCrdtContentAst: a single text token (or a one-child paragraph) whose
  text is a JSON-encoded AST unwraps to the inner document;
- isFlatTokenStream: v2 token discriminators pass through unchanged;
- legacyAstToTokens: paragraph/heading children flatten into one stream;
  strong/em/strikethrough/underline/highlight fold into `marks` on text runs
  (underline -> highlight; nested marks merge); node_link pills become
  `mention` tokens (ref_type class -> `class_chip`); code -> text run with the
  `code` mark; math/external_link/hard_break map 1:1; user_mention degrades to
  a plain '@label' text run; unknown nodes contribute their children.
"""

from __future__ import annotations

import json
from typing import Any

MARKS = ("bold", "italic", "strike", "highlight", "code")

FLAT_TYPES = {
    "text", "typed_link", "mention", "class_chip", "external_link", "math",
    "hard_break", "asset_ref", "embed_ref", "query", "whiteboard", "quote",
}


def _try_parse_json(source: str) -> Any:
    try:
        return json.loads(source)
    except ValueError:
        return None


def unwrap_crdt_content_ast(ast: list[Any]) -> list[Any]:
    if len(ast) != 1:
        return ast
    block = ast[0]
    wrapped_text: str | None = None
    if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
        wrapped_text = block["text"]
    elif (
        isinstance(block, dict)
        and block.get("type") == "paragraph"
        and isinstance(block.get("children"), list)
        and len(block["children"]) == 1
    ):
        child = block["children"][0]
        if isinstance(child, dict) and child.get("type") == "text" and isinstance(child.get("text"), str):
            wrapped_text = child["text"]
    if not wrapped_text:
        return ast
    inner = _try_parse_json(wrapped_text)
    if isinstance(inner, list) and inner:
        return inner
    return ast


def is_flat_token_stream(ast: list[Any]) -> bool:
    if not ast:
        return True
    for entry in ast:
        if not isinstance(entry, dict):
            return False
        token_type = entry.get("type")
        if not isinstance(token_type, str) or token_type not in FLAT_TYPES:
            return False
    return True


def normalize_content_ast(ast: list[Any], resolve_name: Any = None) -> list[dict[str, Any]]:
    unwrapped = unwrap_crdt_content_ast(ast)
    if is_flat_token_stream(unwrapped):
        return [e for e in unwrapped if isinstance(e, dict)]
    return legacy_ast_to_tokens(unwrapped, resolve_name)


def legacy_ast_to_tokens(ast: list[Any], resolve_name: Any = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for block in ast:
        if isinstance(block, dict):
            _convert_block(block, out, frozenset(), resolve_name)
    return out


def _convert_block(block: dict[str, Any], out: list[dict[str, Any]], inherited: frozenset[str], resolve_name: Any = None) -> None:
    block_type = block.get("type")
    if block_type in ("paragraph", "heading"):
        for child in block.get("children") or []:
            if isinstance(child, dict):
                _convert_inline(child, out, inherited, resolve_name)
    elif block_type == "text":
        text = block.get("text")
        if isinstance(text, str):
            out.append(_text_token(text, inherited))
    elif block_type == "whiteboard":
        data = block.get("data")
        if isinstance(data, dict):
            out.append({"type": "whiteboard", "layout": data})
    elif block_type == "query":
        data = block.get("data")
        out.append({"type": "query", "queryAst": data if isinstance(data, dict) else {}})
    else:
        # Unknown legacy block: try its children so no text is lost.
        for child in block.get("children") or []:
            if isinstance(child, dict):
                _convert_inline(child, out, inherited, resolve_name)


def _convert_inline(node: dict[str, Any], out: list[dict[str, Any]], inherited: frozenset[str], resolve_name: Any = None) -> None:
    node_type = node.get("type")
    if node_type == "text":
        text = node.get("text")
        if isinstance(text, str):
            out.append(_text_token(text, inherited))
    elif node_type == "hard_break":
        out.append({"type": "hard_break"})
    elif node_type in ("strong", "em", "strikethrough", "underline", "highlight"):
        mark = {
            "strong": "bold",
            "em": "italic",
            "strikethrough": "strike",
            "underline": "highlight",
            "highlight": "highlight",
        }[node_type]
        _convert_children(node, out, inherited, mark, resolve_name)
    elif node_type == "code":
        text = node.get("text")
        out.append(_text_token(text if isinstance(text, str) else "", inherited | {"code"}))
    elif node_type == "math":
        expression = node.get("expression")
        out.append({"type": "math", "expression": expression if isinstance(expression, str) else ""})
    elif node_type == "external_link":
        url = node.get("url")
        out.append({
            "type": "external_link",
            "href": url if isinstance(url, str) else "",
            "text": _collect_plain(node),
        })
    elif node_type == "node_link":
        link_id = node.get("link_id") if isinstance(node.get("link_id"), str) else ""
        target = link_id.split(":")[0] if link_id else ""
        label = node.get("label") if isinstance(node.get("label"), str) else ""
        ref_type = node.get("ref_type") if isinstance(node.get("ref_type"), str) else "node"
        if ref_type == "class":
            token: dict[str, Any] = {"type": "class_chip", "classId": target}
            if label:
                token["displayText"] = label
            out.append(token)
        else:
            # Unlabeled links must NOT fall back to the target id: the uuid
            # would leak into excerpts/breadcrumbs as the node's display
            # text. Resolve the v1 name when the migrator supplies a
            # resolver; otherwise leave the captured text empty (v2 renders
            # resolve the target's live name at display time).
            captured = label if label else (resolve_name(target) if callable(resolve_name) else "")
            out.append({"type": "mention", "targetNodeId": target, "text": captured})
    elif node_type == "user_mention":
        label = node.get("label")
        out.append(_text_token(f"@{label if isinstance(label, str) else ''}", inherited))
    else:
        for child in node.get("children") or []:
            if isinstance(child, dict):
                _convert_inline(child, out, inherited, resolve_name)


def _convert_children(node: dict[str, Any], out: list[dict[str, Any]], inherited: frozenset[str], mark: str, resolve_name: Any = None) -> None:
    merged = inherited | {mark}
    for child in node.get("children") or []:
        if isinstance(child, dict):
            _convert_inline(child, out, merged, resolve_name)


def _text_token(text: str, marks: frozenset[str]) -> dict[str, Any]:
    valid = [m for m in MARKS if m in marks]
    token: dict[str, Any] = {"type": "text", "text": text}
    if valid:
        token["marks"] = valid
    return token


def _collect_plain(node: Any) -> str:
    buffer: list[str] = []

    def walk(n: Any) -> None:
        if isinstance(n, dict):
            text = n.get("text")
            if isinstance(text, str):
                buffer.append(text)
            for child in n.get("children") or []:
                walk(child)
        elif isinstance(n, list):
            for item in n:
                walk(item)

    walk(node)
    return "".join(buffer)


def content_tokens_from_source(source: Any, resolve_name: Any = None) -> list[dict[str, Any]]:
    """Parse a stored content document (serialized JSON or decoded list)."""
    if source is None:
        return []
    if isinstance(source, str):
        if not source:
            return []
        parsed = _try_parse_json(source)
        if not isinstance(parsed, list):
            # Legacy plain-text content.
            return [{"type": "text", "text": source}]
        return normalize_content_ast(parsed, resolve_name)
    if isinstance(source, list):
        return normalize_content_ast(source)
    return []


def plain_text(tokens: list[dict[str, Any]]) -> str:
    """v2-flavored plain text: text runs + mention display text."""
    parts: list[str] = []
    for token in tokens:
        token_type = token.get("type")
        if token_type == "text":
            parts.append(token.get("text", ""))
        elif token_type == "mention":
            parts.append(token.get("text", ""))
        elif token_type == "class_chip":
            parts.append(token.get("displayText", ""))
        elif token_type == "external_link":
            parts.append(token.get("text", ""))
    return "".join(parts)


def normalize_class_name(name: Any) -> str:
    """v1 `_normalize_class_name`: JSON-AST names become their plain text."""
    if not isinstance(name, str):
        return "Untitled class"
    name = name.strip()
    if not name:
        return "Untitled class"
    if name.startswith("["):
        try:
            ast = json.loads(name)
        except ValueError:
            return name
        if isinstance(ast, list):
            parts: list[str] = []
            _collect_class_text(ast, parts)
            return "".join(parts).strip() or "Untitled class"
    return name


def _collect_class_text(value: Any, parts: list[str]) -> None:
    if isinstance(value, list):
        for item in value:
            _collect_class_text(item, parts)
    elif isinstance(value, dict):
        if value.get("type") == "text" and isinstance(value.get("text"), str):
            parts.append(value["text"])
        for child in value.get("children") or []:
            _collect_class_text(child, parts)
