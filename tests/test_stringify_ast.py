"""
Tests for the canonical AST → string stringifier (Python backend).

Mirrors the frontend test suite to guarantee parity.
"""
import pytest

from app.domain.stringify_ast import (
    StringifyMode,
    StringifyOptions,
    NodeLinkResolution,
    stringify_ast,
    parse_ast,
)


# ── Helpers ─────────────────────────────────────────────────────────


def p(*children):
    """Build a single paragraph."""
    return [{"type": "paragraph", "children": list(children)}]


def text(t):
    return {"type": "text", "text": t}


def strong(*children):
    return {"type": "strong", "children": list(children)}


def em(*children):
    return {"type": "em", "children": list(children)}


def code(t):
    return {"type": "code", "text": t}


def hard_break():
    return {"type": "hard_break"}


def node_link(link_id, ref_type="node"):
    return {"type": "node_link", "link_id": link_id, "ref_type": ref_type}


def ext_link(url, *children):
    return {"type": "external_link", "url": url, "children": list(children)}


def strike(*children):
    return {"type": "strikethrough", "children": list(children)}


def hl(*children):
    return {"type": "highlight", "children": list(children)}


def opts(mode, resolver=None, max_length=None):
    return StringifyOptions(
        mode=mode,
        max_length=max_length,
        resolve_node_link=resolver,
    )


def make_resolver(mapping):
    """mapping: {link_id: {"ast": [...], "label": str|None, "target_id": str}}"""
    def resolve(link_id):
        entry = mapping.get(link_id)
        if entry is None:
            return None
        return NodeLinkResolution(
            target_ast=entry["ast"],
            label=entry.get("label"),
            target_id=entry.get("target_id", link_id),
        )
    return resolve


# ── Text nodes ──────────────────────────────────────────────────────


class TestTextNodes:
    ast = p(text("Hello world"))

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "Hello world"

    def test_plain_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.PLAIN_MARKDOWN)) == "Hello world"

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "Hello world"


# ── Empty document ──────────────────────────────────────────────────


class TestEmptyDocument:
    def test_empty(self):
        assert stringify_ast([], opts(StringifyMode.NODE_MARKDOWN)) == ""
        assert stringify_ast([], opts(StringifyMode.TEXT_ONLY)) == ""


# ── Formatting ──────────────────────────────────────────────────────


class TestStrong:
    ast = p(text("a "), strong(text("bold")), text(" b"))

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "a **bold** b"

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "a bold b"


class TestEm:
    ast = p(text("a "), em(text("italic")), text(" b"))

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "a *italic* b"

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "a italic b"


class TestCode:
    ast = p(text("run "), code("npm install"))

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "run `npm install`"

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "run npm install"


class TestStrikethrough:
    ast = p(strike(text("removed")))

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "~~removed~~"

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "removed"


class TestHighlight:
    ast = p(hl(text("important")))

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "==important=="

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "important"


class TestNestedFormatting:
    ast = p(strong(em(text("bold italic"))))

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "***bold italic***"

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "bold italic"


# ── Hard break ──────────────────────────────────────────────────────


class TestHardBreak:
    ast = p(text("line one"), hard_break(), text("line two"))

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "line one  \nline two"

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "line one line two"


# ── External link ──────────────────────────────────────────────────


class TestExternalLink:
    ast = p(text("see "), ext_link("https://example.com", text("here")))

    def test_node_markdown(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN))
            == "see [here](https://example.com)"
        )

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "see here"


# ── Multiple paragraphs ────────────────────────────────────────────


class TestMultipleParagraphs:
    ast = [
        {"type": "paragraph", "children": [text("First.")]},
        {"type": "paragraph", "children": [text("Second.")]},
    ]

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "First.\n\nSecond."

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "First. Second."


# ── maxLength ──────────────────────────────────────────────────────


class TestMaxLength:
    ast = p(text("Hello world, this is long"))

    def test_truncates(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY, max_length=5)) == "Hello"

    def test_no_truncation_under_limit(self):
        result = stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY, max_length=1000))
        assert result == "Hello world, this is long"


# ── Node links ──────────────────────────────────────────────────────

_link_resolver = make_resolver({
    "link-aaa": {"ast": p(text("ISO 14971")), "target_id": "n1"},
})

_label_resolver = make_resolver({
    "link-bbb": {"ast": p(text("ISO 14971")), "label": "risk standard", "target_id": "n1"},
})

_class_resolver = make_resolver({
    "link-ccc": {"ast": p(text("Task")), "target_id": "class-task"},
    "link-ddd": {"ast": p(text("Bug")), "label": "issue", "target_id": "class-bug"},
})

_empty_resolver = make_resolver({})


class TestNodeLinkWithoutLabel:
    ast = p(text("See "), node_link("link-aaa"))

    def test_node_markdown(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN, _link_resolver))
            == "See [[ISO 14971]]"
        )

    def test_plain_markdown(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.PLAIN_MARKDOWN, _link_resolver))
            == "See ISO 14971"
        )

    def test_text_only(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY, _link_resolver))
            == "See ISO 14971"
        )


class TestNodeLinkWithLabel:
    ast = p(text("See the "), node_link("link-bbb"))

    def test_node_markdown(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN, _label_resolver))
            == "See the [risk standard]([[ISO 14971]])"
        )

    def test_plain_markdown(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.PLAIN_MARKDOWN, _label_resolver))
            == "See the risk standard"
        )

    def test_text_only(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY, _label_resolver))
            == "See the risk standard"
        )


class TestClassRefType:
    def test_class_without_label(self):
        ast = p(text("This is a "), node_link("link-ccc", "class"))
        assert (
            stringify_ast(ast, opts(StringifyMode.NODE_MARKDOWN, _class_resolver))
            == "This is a {{Task}}"
        )

    def test_class_with_label(self):
        ast = p(text("Filed as "), node_link("link-ddd", "class"))
        assert (
            stringify_ast(ast, opts(StringifyMode.NODE_MARKDOWN, _class_resolver))
            == "Filed as issue"
        )


class TestUnresolvableLink:
    ast = p(text("See "), node_link("link-gone"))

    def test_node_markdown(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN, _empty_resolver))
            == "See [[…]]"
        )

    def test_plain_markdown(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.PLAIN_MARKDOWN, _empty_resolver))
            == "See …"
        )


class TestNoResolver:
    ast = p(text("See "), node_link("link-aaa"))

    def test_node_markdown(self):
        assert stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN)) == "See [[…]]"

    def test_text_only(self):
        assert stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY)) == "See …"


# ── Cycle detection ─────────────────────────────────────────────────


class TestCycleDetection:
    def _resolver(self, link_id):
        if link_id == "link-to-b":
            return NodeLinkResolution(
                target_ast=p(text("B says "), node_link("link-to-a")),
                label=None,
                target_id="node-b",
            )
        if link_id == "link-to-a":
            return NodeLinkResolution(
                target_ast=p(text("A says "), node_link("link-to-b")),
                label=None,
                target_id="node-a",
            )
        return None

    def test_node_markdown(self):
        ast = p(text("Start: "), node_link("link-to-b"))
        result = stringify_ast(ast, opts(StringifyMode.NODE_MARKDOWN, self._resolver))
        assert result == "Start: [[B says [[A says [[…]]]]]]"

    def test_text_only(self):
        ast = p(text("Start: "), node_link("link-to-b"))
        result = stringify_ast(ast, opts(StringifyMode.TEXT_ONLY, self._resolver))
        assert result == "Start: B says A says …"


class TestSelfReference:
    def _resolver(self, link_id):
        if link_id == "link-self":
            return NodeLinkResolution(
                target_ast=p(text("Me "), node_link("link-self")),
                label=None,
                target_id="node-self",
            )
        return None

    def test_breaks_self_cycle(self):
        ast = p(node_link("link-self"))
        result = stringify_ast(ast, opts(StringifyMode.NODE_MARKDOWN, self._resolver))
        assert result == "[[Me [[…]]]]"


# ── parse_ast ──────────────────────────────────────────────────────


class TestParseAST:
    def test_json_string(self):
        import json
        ast = [{"type": "paragraph", "children": [{"type": "text", "text": "hi"}]}]
        result = parse_ast(json.dumps(ast))
        assert result == ast

    def test_list_passthrough(self):
        ast = [{"type": "paragraph", "children": []}]
        assert parse_ast(ast) == ast

    def test_plain_string_returns_empty(self):
        """Plain text is NOT valid AST - use parse_ast(text, ParseMode.PLAIN) to create content."""
        result = parse_ast("hello world")
        assert result == []

    def test_empty_string(self):
        assert parse_ast("") == []

    def test_none(self):
        assert parse_ast(None) == []

    def test_invalid_json_returns_empty(self):
        """Invalid JSON is NOT valid AST - returns empty document."""
        result = parse_ast("{broken")
        assert result == []

    def test_number_string_returns_empty(self):
        """A number like '2026' is valid JSON but NOT valid AST - returns empty."""
        result = parse_ast("2026")
        assert result == []

    def test_invalid_structure(self):
        # Not a list of dicts with "type"
        assert parse_ast([1, 2, 3]) == []


# ── parse_ast with ParseMode.PLAIN ─────────────────────────────────


class TestParseASTPlain:
    def test_simple_text(self):
        from app.domain.stringify_ast import parse_ast, serialize_ast, ParseMode
        import json
        
        ast = parse_ast("Hello World", ParseMode.PLAIN)
        result = serialize_ast(ast)
        parsed = json.loads(result)
        assert parsed == [{"type": "paragraph", "children": [{"type": "text", "text": "Hello World"}]}]
    
    def test_roundtrip(self):
        from app.domain.stringify_ast import parse_ast, serialize_ast, ParseMode
        
        ast_json = serialize_ast(parse_ast("2026", ParseMode.PLAIN))
        result = parse_ast(ast_json)
        assert len(result) == 1
        assert result[0]["children"][0]["text"] == "2026"


# ── Complex mixed content ──────────────────────────────────────────


_complex_resolver = make_resolver({
    "link-x": {"ast": p(text("Design Doc")), "target_id": "n-x"},
})


class TestComplexContent:
    ast = p(
        text("Review the "),
        strong(text("updated ")),
        node_link("link-x"),
        text(" before "),
        em(text("Friday")),
    )

    def test_node_markdown(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.NODE_MARKDOWN, _complex_resolver))
            == "Review the **updated **[[Design Doc]] before *Friday*"
        )

    def test_plain_markdown(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.PLAIN_MARKDOWN, _complex_resolver))
            == "Review the **updated **Design Doc before *Friday*"
        )

    def test_text_only(self):
        assert (
            stringify_ast(self.ast, opts(StringifyMode.TEXT_ONLY, _complex_resolver))
            == "Review the updated Design Doc before Friday"
        )


# ── Unknown AST type ───────────────────────────────────────────────


class TestUnknownType:
    def test_ignored(self):
        ast = [
            {"type": "paragraph", "children": [
                text("before "),
                {"type": "unknown_widget"},
                text(" after"),
            ]},
        ]
        assert stringify_ast(ast, opts(StringifyMode.NODE_MARKDOWN)) == "before  after"
