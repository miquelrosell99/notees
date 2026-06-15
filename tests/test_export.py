"""Tests for the export module (node_export)."""
from app.node_export import (
    build_body_class,
    build_toc_html,
    export_to_html,
    export_to_markdown,
    is_heading_node,
    markdown_inline_to_html,
    node_is_code,
    node_is_quote,
)


class TestMarkdownInlineToHtml:
    """Test the markdown inline-to-HTML converter."""

    def test_escapes_plain_text(self):
        assert markdown_inline_to_html("hello world") == "hello world"

    def test_escapes_html_entities(self):
        assert markdown_inline_to_html("<script>") == "&lt;script&gt;"

    def test_bold_double_star(self):
        assert markdown_inline_to_html("**hello**") == "<strong>hello</strong>"

    def test_bold_double_underscore(self):
        assert markdown_inline_to_html("__hello__") == "<strong>hello</strong>"

    def test_italic_single_star(self):
        assert markdown_inline_to_html("*hello*") == "<em>hello</em>"

    def test_italic_single_underscore(self):
        assert markdown_inline_to_html("_hello_") == "<em>hello</em>"

    def test_code_inline(self):
        assert markdown_inline_to_html("`code`") == "<code>code</code>"

    def test_strikethrough(self):
        assert markdown_inline_to_html("~~gone~~") == "<s>gone</s>"

    def test_highlight(self):
        assert markdown_inline_to_html("==mark==") == "<mark>mark</mark>"

    def test_underline(self):
        assert markdown_inline_to_html("<u>under</u>") == "<u>under</u>"

    def test_external_link(self):
        assert (
            markdown_inline_to_html("[text](https://example.com)")
            == '<a href="https://example.com" class="url-link">text</a>'
        )

    def test_node_anchor_link(self):
        assert (
            markdown_inline_to_html("[text](#uuid-123)")
            == '<a href="#uuid-123" class="node-link">text</a>'
        )

    def test_hard_break(self):
        # Two spaces + newline becomes <br>
        assert markdown_inline_to_html("line1  \nline2") == "line1<br>line2"

    def test_normal_newline_becomes_space(self):
        assert markdown_inline_to_html("line1\nline2") == "line1 line2"

    def test_mixed_formatting(self):
        md = "**bold** and *italic* and `code`"
        html = markdown_inline_to_html(md)
        assert "<strong>bold</strong>" in html
        assert "<em>italic</em>" in html
        assert "<code>code</code>" in html


class TestBuildTocHtml:
    """Test TOC generation from node list."""

    def test_empty_nodes(self):
        assert build_toc_html([], lambda n: n.get("name", ""), __import__("html")) == ""

    def test_single_page_node(self):
        nodes = [{"uuid": "abc", "name": "Hello", "is_page": True, "depth": 0}]
        html = build_toc_html(nodes, lambda n: n["name"], __import__("html"))
        assert '<nav class="toc">' in html
        assert '<a href="#abc">Hello</a>' in html

    def test_heading_node_included(self):
        nodes = [
            {"uuid": "p1", "name": "Page", "is_page": True, "depth": 0},
            {"uuid": "h1", "name": '[{"type":"heading","children":[{"type":"text","text":"Heading"}]}]', "is_page": False, "depth": 1},
        ]
        html = build_toc_html(nodes, lambda n: n["name"], __import__("html"))
        assert "Page" in html
        assert "Heading" in html

    def test_nested_depth(self):
        nodes = [
            {"uuid": "p1", "name": "A", "is_page": True, "depth": 0},
            {"uuid": "p2", "name": "B", "is_page": True, "depth": 1},
        ]
        html = build_toc_html(nodes, lambda n: n["name"], __import__("html"))
        assert html.count("<ul>") >= 2
        assert html.count("</ul>") >= 2


class TestIsHeadingNode:
    """Test heading detection."""

    def test_plain_text_is_not_heading(self):
        assert is_heading_node({"name": "plain text"}) is False

    def test_heading_ast_is_heading(self):
        assert is_heading_node({"name": '[{"type":"heading","children":[{"type":"text","text":"Hi"}]}]'}) is True


class TestNodeClassDetection:
    """Test code / quote class detection."""

    def testnode_is_code_with_matching_class(self):
        assert node_is_code({"class_ids": [1, 2, 3]}, 2) is True

    def testnode_is_code_without_matching_class(self):
        assert node_is_code({"class_ids": [1, 3]}, 2) is False

    def testnode_is_code_with_none_class_id(self):
        assert node_is_code({"class_ids": [1, 3]}, None) is False

    def testnode_is_quote_with_matching_class(self):
        assert node_is_quote({"class_ids": [5]}, 5) is True

    def testnode_is_quote_without_class_ids(self):
        assert node_is_quote({"class_ids": []}, 5) is False


class TestExportToHtmlCodeAndQuote:
    """Test HTML export renders code and quote blocks correctly."""

    def test_code_block_renders_pre_code(self):
        nodes = [{"uuid": "c1", "name": '[{"type":"paragraph","children":[{"type":"text","text":"print(\'hi\')"}]}]', "is_page": False, "depth": 0, "class_ids": [99]}]
        html = export_to_html(nodes, code_class_id=99)
        assert '<pre class="code-block"' in html
        assert '<code class="highlight">' in html
        assert 'print' in html
        assert 'hi' in html
        assert '</pre>' in html

    def test_quote_block_renders_blockquote(self):
        nodes = [{"uuid": "q1", "name": '[{"type":"paragraph","children":[{"type":"text","text":"To be or not"}]}]', "is_page": False, "depth": 0, "class_ids": [88]}]
        html = export_to_html(nodes, quote_class_id=88)
        assert '<blockquote' in html
        assert "To be or not" in html
        assert '</blockquote>' in html

    def test_regular_block_renders_li(self):
        nodes = [{"uuid": "r1", "name": '[{"type":"paragraph","children":[{"type":"text","text":"normal"}]}]', "is_page": False, "depth": 0, "class_ids": []}]
        html = export_to_html(nodes)
        assert '<li class="node-block"' in html
        assert "normal" in html


class TestExportToMarkdownCodeAndQuote:
    """Test Markdown export renders code and quote blocks correctly."""

    def test_code_block_renders_backticks(self):
        nodes = [{"uuid": "c1", "name": '[{"type":"paragraph","children":[{"type":"text","text":"print(\'hi\')"}]}]', "is_page": False, "depth": 0, "class_ids": [99]}]
        md = export_to_markdown(nodes, code_class_id=99)
        assert "```" in md
        assert "print('hi')" in md

    def test_quote_block_renders_gt_prefix(self):
        nodes = [{"uuid": "q1", "name": '[{"type":"paragraph","children":[{"type":"text","text":"To be or not"}]}]', "is_page": False, "depth": 0, "class_ids": [88]}]
        md = export_to_markdown(nodes, quote_class_id=88)
        assert "> To be or not" in md

    def test_regular_block_renders_bullet(self):
        nodes = [{"uuid": "r1", "name": '[{"type":"paragraph","children":[{"type":"text","text":"normal"}]}]', "is_page": False, "depth": 0, "class_ids": []}]
        md = export_to_markdown(nodes)
        assert "- normal" in md


class TestBuildBodyClass:
    """Test body class builder."""

    def test_default_body_class(self):
        cls = build_body_class("modern", "outline", "comfortable", "none")
        assert "theme-modern" in cls
        assert "structure-indented" in cls

    def test_dark_mode_body_class(self):
        cls = build_body_class("modern", "outline", "comfortable", "none", theme_mode="dark")
        assert "theme-modern" in cls
        assert "theme-dark" in cls

    def test_technical_theme_body_class(self):
        cls = build_body_class("technical", "flat", "compact", "hierarchical")
        assert "theme-technical" in cls
        assert "theme-modern" not in cls
