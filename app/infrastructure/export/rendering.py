"""HTML and Markdown rendering helpers for node export."""

from __future__ import annotations

import html
from pathlib import Path
from typing import Any

from ...domain.stringify_ast import (
    StringifyMode,
    StringifyOptions,
    parse_ast,
    stringify_ast,
)
from ...logging_config import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Export stylesheet constants
# ---------------------------------------------------------------------------
_EXPORT_CSS_DIR = Path(__file__).resolve().parent.parent.parent / "static" / "export"

EXPORT_THEMES = {"modern", "editorial", "technical", "book", "casual"}
EXPORT_DENSITIES = {"comfortable", "compact"}
EXPORT_NUMBERING = {"none", "hierarchical", "legal", "appendix"}
EXPORT_MEASURES = {"full", "readable", "book", "two-column"}
EXPORT_DOCTYPES = {"none", "article", "report", "book", "legal", "academic"}

_export_css_cache: str | None = None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def is_heading_node(node_data: dict) -> bool:
    """Return True if the node's first AST block has type 'heading'."""
    ast = node_data.get("_ast") or parse_ast(node_data.get("name", ""))
    return bool(ast and isinstance(ast, list) and ast[0].get("type") == "heading")


def _stringify_node(
    node_data: dict, mode: StringifyMode, resolver, html_anchors: bool = False, strip_link_syntax: bool = False
) -> str:
    """Stringify a single node's AST to text."""
    ast = node_data.get("_ast") or parse_ast(node_data.get("name", ""))
    opts = StringifyOptions(
        mode=mode, resolve_node_link=resolver, html_anchors=html_anchors, strip_link_syntax=strip_link_syntax
    )
    return stringify_ast(ast, opts)


def markdown_inline_to_html(md: str) -> str:
    """Convert PLAIN_MARKDOWN inline syntax to HTML with proper escaping.

    Tokenises the string produced by stringify_ast(PLAIN_MARKDOWN) so that:
    - User-typed text segments are HTML-escaped.
    - Markdown formatting tokens are translated to the matching HTML element.
    - Hard breaks (two spaces + newline) become <br>.
    - Node links ([[uuid]]) and anchor links (#uuid) are classified correctly.
    """
    import html as _html
    import re as _re

    # Pre-process: hard breaks → <br>, remaining newlines → space
    md = md.replace("  \n", "<br>\n")
    md = md.replace("\n", " ")
    md = md.replace("<br> ", "<br>")

    token_re = _re.compile(
        r"(\$\$.+?\$\$)"  # display math
        r"|(\$[^$\s].*?\$)"  # inline math
        r"|(`[^`]+`)"  # code — highest priority to protect contents
        r"|(\*\*.+?\*\*)"  # bold **
        r"|(__.+?__)"  # bold __
        r"|(\*.+?\*)"  # italic *
        r"|(_.+?_)"  # italic _
        r"|(~~.+?~~)"  # strikethrough
        r"|(==.+?==)"  # highlight
        r"|(<u>.+?</u>)"  # underline (already HTML from stringify)
        r"|(\[.+?\]\([^)]+\))",  # link
        _re.DOTALL,
    )

    result: list[str] = []
    last = 0
    for m in token_re.finditer(md):
        if m.start() > last:
            segment = md[last : m.start()]
            # Preserve <br> tags inserted during pre-processing
            parts = segment.split("<br>")
            escaped_parts = [_html.escape(p) for p in parts]
            result.append("<br>".join(escaped_parts))
        token = m.group(0)
        if token.startswith("$$"):
            result.append(f'<span class="math math--display">{_html.escape(token[2:-2])}</span>')
        elif token.startswith("$"):
            result.append(f'<span class="math">{_html.escape(token[1:-1])}</span>')
        elif token.startswith("`"):
            result.append(f"<code>{_html.escape(token[1:-1])}</code>")
        elif token.startswith("**") or token.startswith("__"):
            result.append(f"<strong>{_html.escape(token[2:-2])}</strong>")
        elif token.startswith("*") or token.startswith("_"):
            result.append(f"<em>{_html.escape(token[1:-1])}</em>")
        elif token.startswith("~~"):
            result.append(f"<s>{_html.escape(token[2:-2])}</s>")
        elif token.startswith("=="):
            result.append(f"<mark>{_html.escape(token[2:-2])}</mark>")
        elif token.startswith("<u>"):
            result.append(f"<u>{_html.escape(token[3:-4])}</u>")
        else:
            lm = _re.match(r"\[(.+?)\]\(([^)]+)\)", token)
            if lm:
                href = lm.group(2)
                link_text = lm.group(1)
                if href.startswith("#"):
                    result.append(f'<a href="{_html.escape(href)}" class="node-link">{_html.escape(link_text)}</a>')
                elif href.startswith("[[") and href.endswith("]]"):
                    # Raw node link syntax (fallback when html_anchors=False)
                    result.append(f'<a href="{_html.escape(href)}" class="node-link">{_html.escape(link_text)}</a>')
                else:
                    result.append(f'<a href="{_html.escape(href)}" class="url-link">{_html.escape(link_text)}</a>')
            else:
                result.append(_html.escape(token))
        last = m.end()
    if last < len(md):
        segment = md[last:]
        parts = segment.split("<br>")
        escaped_parts = [_html.escape(p) for p in parts]
        result.append("<br>".join(escaped_parts))
    return "".join(result)


def _highlight_code(text: str, language: str | None = None) -> str:
    """Highlight code with Pygments.

    Falls back to plain text if Pygments is missing or cannot determine a lexer.
    """
    try:
        from pygments import highlight as pygments_highlight
        from pygments.formatters import HtmlFormatter
        from pygments.lexers import get_lexer_by_name, guess_lexer
        from pygments.util import ClassNotFound
    except ImportError:
        return html.escape(text)

    try:
        lexer = get_lexer_by_name(language) if language else guess_lexer(text)
    except ClassNotFound:
        try:
            lexer = guess_lexer(text)
        except Exception:
            return html.escape(text)
    except Exception:
        return html.escape(text)

    formatter = HtmlFormatter(nowrap=True)
    return pygments_highlight(text, lexer, formatter)


def _get_export_css_single() -> str:
    """Read and cache the layered export CSS from layers/ directory."""
    global _export_css_cache
    if _export_css_cache is None:
        layers_dir = _EXPORT_CSS_DIR / "layers"
        parts: list[str] = []
        for layer_path in sorted(layers_dir.glob("*.css")):
            try:
                parts.append(layer_path.read_text(encoding="utf-8"))
            except Exception as exc:
                logger.warning("Failed to read export CSS layer %s: %s", layer_path, exc)
        if not parts:
            logger.warning("No export CSS layers found in %s", layers_dir)
        _export_css_cache = "\n\n".join(parts)
    return _export_css_cache


def build_body_class(
    style: str | None,
    layout: str,
    density: str,
    numbering: str,
    measure: str = "full",
    doctype: str = "none",
    section_break: bool = False,
    theme_mode: str = "light",
    cover_page: bool = False,
    page_size: str = "a4",
) -> str:
    """Return the body class string encoding all render axes."""
    theme = style if style in EXPORT_THEMES else "modern"
    structure = "flat" if layout == "flat" else "indented"
    dens = density if density in EXPORT_DENSITIES else "comfortable"
    num = numbering if numbering in EXPORT_NUMBERING else "none"
    msr = measure if measure in EXPORT_MEASURES else "full"
    dt = doctype if doctype in EXPORT_DOCTYPES and doctype != "none" else ""
    classes = f"theme-{theme} structure-{structure} density-{dens} numbering-{num} layout-{msr}"
    if dt:
        classes += f" doctype-{dt}"
    if section_break:
        classes += " section-break-before"
    if cover_page:
        classes += " cover-page"
    if theme_mode == "dark":
        classes += " theme-dark"
    if page_size in {"a4", "letter", "legal"}:
        classes += f" page-size-{page_size}"
    return classes


def _html_style_tag(page_size: str = "a4") -> str:
    """Return <style> elements containing the full export CSS plus page-size override."""
    css = _get_export_css_single().strip()
    parts: list[str] = []
    if css:
        parts.append(f"<style>\n{css}\n</style>")
    size = page_size if page_size in {"a4", "letter", "legal"} else "a4"
    if size != "a4":
        parts.append(f"<style>\n@page {{ size: {size}; }}\n</style>")
    return "\n".join(parts)


def build_toc_html(nodes: list[dict], title_fn, html_mod) -> str:
    """Build a Table of Contents from page and heading nodes."""
    entries = []
    for node in nodes:
        if node.get("is_page") or is_heading_node(node):
            entries.append(
                {
                    "uuid": node.get("uuid", ""),
                    "text": title_fn(node),
                    "depth": node.get("depth", 0),
                }
            )
    if not entries:
        return ""

    parts: list[str] = []
    current_depth = entries[0]["depth"]
    parts.append("<ul>")
    for e in entries:
        depth = e["depth"]
        if depth > current_depth:
            parts.append("<ul>")
            current_depth = depth
        elif depth < current_depth:
            while current_depth > depth:
                parts.append("</ul>")
                current_depth -= 1
        parts.append(f'<li><a href="#{html_mod.escape(e["uuid"])}">{html_mod.escape(e["text"])}</a></li>')
    while current_depth >= entries[0]["depth"]:
        parts.append("</ul>")
        current_depth -= 1
    return f'<nav class="toc"><h2>Table of Contents</h2>{"".join(parts)}</nav>'


def _build_cover_html(metadata: dict[str, Any] | None, html_mod) -> str:
    """Build a dedicated cover page section from node metadata."""
    if not metadata:
        return ""
    title = html_mod.escape(str(metadata.get("title", "Notees Export")))
    parts: list[str] = ['<section class="cover">']
    icon = metadata.get("icon")
    if icon:
        parts.append(f'<div class="cover__icon">{html_mod.escape(str(icon))}</div>')
    parts.append(f'<h1 class="cover__title">{title}</h1>')
    subtitle = metadata.get("subtitle")
    if subtitle:
        parts.append(f'<p class="cover__subtitle">{html_mod.escape(str(subtitle))}</p>')
    date_str = metadata.get("write_date") or metadata.get("create_date")
    if date_str:
        parts.append(f'<p class="cover__date">{html_mod.escape(str(date_str)[:10])}</p>')
    tags = metadata.get("tags")
    if tags:
        tag_labels = [html_mod.escape(str(t.get("name", t) if isinstance(t, dict) else t)) for t in tags]
        parts.append('<div class="cover__tags">' + "".join(f'<span class="tag-pill">{t}</span>' for t in tag_labels) + "</div>")
    classes = metadata.get("classes")
    if classes:
        class_labels = [html_mod.escape(str(c.get("name", c) if isinstance(c, dict) else c)) for c in classes]
        parts.append('<div class="cover__classes">' + "".join(f'<span class="tag-pill">{c}</span>' for c in class_labels) + "</div>")
    parts.append("</section>")
    return "\n".join(parts)


def node_is_code(node: dict, code_class_id: str | None) -> bool:
    return code_class_id is not None and code_class_id in (node.get("class_ids") or [])


def node_is_quote(node: dict, quote_class_id: str | None) -> bool:
    return quote_class_id is not None and quote_class_id in (node.get("class_ids") or [])


def _node_callout_type(node: dict, callout_class_map: dict[str, str]) -> str | None:
    class_ids = node.get("class_ids") or []
    for cid in class_ids:
        if cid in callout_class_map:
            return callout_class_map[cid]
    return None


def export_to_markdown(
    nodes: list[dict],
    resolver=None,
    layout: str = "outline",
    formatting: bool = True,
    properties_data: dict[str, list] | None = None,
    strip_link_syntax: bool = False,
    code_class_id: str | None = None,
    quote_class_id: str | None = None,
    callout_class_map: dict[str, str] | None = None,
) -> str:
    """Convert nodes to Markdown format."""
    if not nodes:
        return ""

    _props = properties_data or {}
    lines = []
    for node in nodes:
        text = _stringify_node(node, StringifyMode.PLAIN_MARKDOWN, resolver, strip_link_syntax=strip_link_syntax)
        depth = node.get("depth", 0)
        is_page = node.get("is_page", False)
        is_code = node_is_code(node, code_class_id)
        is_quote = node_is_quote(node, quote_class_id)
        callout_type = _node_callout_type(node, callout_class_map or {})

        if formatting and node.get("color"):
            text = f"=={text}=="

        def _render_md_block(
            content: str, indent_prefix: str = "", _is_code: bool = is_code, _callout_type: str | None = callout_type, _is_quote: bool = is_quote
        ) -> None:
            if _is_code:
                # Code blocks: triple backticks, indented by depth
                lines.append(f"{indent_prefix}```")
                for code_line in content.split("\n"):
                    lines.append(f"{indent_prefix}{code_line}")
                lines.append(f"{indent_prefix}```")
            elif _callout_type:
                lines.append(f"{indent_prefix}> [!{_callout_type.upper()}]")
                for q_line in content.split("\n"):
                    lines.append(f"{indent_prefix}> {q_line}")
            elif _is_quote:
                for q_line in content.split("\n"):
                    lines.append(f"{indent_prefix}> {q_line}")
            else:
                lines.append(f"{indent_prefix}{content}")

        if is_page and layout == "flat":
            hashes = "#" * (depth + 1)
            lines.append(f"{hashes} {text}")
            props = _props.get(node.get("uuid", ""), [])
            for p in props:
                if p.get("subtree"):
                    lines.append(f"{p['name']}::")
                    for sub_nd in p["subtree"]:
                        sub_text = _stringify_node(
                            sub_nd, StringifyMode.PLAIN_MARKDOWN, resolver, strip_link_syntax=strip_link_syntax
                        )
                        if formatting and sub_nd.get("color"):
                            sub_text = f"=={sub_text}=="
                        sub_depth = sub_nd.get("depth", 0)
                        sub_indent = "  " * (sub_depth + 1)
                        lines.append(f"{sub_indent}- {sub_text}")
                elif p["values"]:
                    lines.append(f"{p['name']}:: {', '.join(p['values'])}")
                else:
                    lines.append(f"{p['name']}::")
        elif layout == "flat":
            is_heading = is_heading_node(node)
            if is_heading:
                hashes = "#" * min(depth + 1, 6)
                lines.append(f"{hashes} {text}")
            else:
                _render_md_block(text)
            props = _props.get(node.get("uuid", ""), [])
            for p in props:
                if p.get("subtree"):
                    lines.append(f"{p['name']}::")
                    for sub_nd in p["subtree"]:
                        sub_text = _stringify_node(
                            sub_nd, StringifyMode.PLAIN_MARKDOWN, resolver, strip_link_syntax=strip_link_syntax
                        )
                        if formatting and sub_nd.get("color"):
                            sub_text = f"=={sub_text}=="
                        sub_depth = sub_nd.get("depth", 0)
                        sub_indent = "  " * (sub_depth + 1)
                        lines.append(f"{sub_indent}- {sub_text}")
                elif p["values"]:
                    lines.append(f"{p['name']}:: {', '.join(p['values'])}")
                else:
                    lines.append(f"{p['name']}::")
        else:
            # outline
            is_heading = is_heading_node(node)
            if is_heading:
                hashes = "#" * min(depth + 1, 6)
                lines.append(f"{hashes} {text}")
            else:
                indent = "  " * depth
                _render_md_block(text, indent + "- ")
            indent = "  " * depth
            props = _props.get(node.get("uuid", ""), [])
            for p in props:
                if p.get("subtree"):
                    lines.append(f"{indent}  {p['name']}::")
                    for sub_nd in p["subtree"]:
                        sub_text = _stringify_node(
                            sub_nd, StringifyMode.PLAIN_MARKDOWN, resolver, strip_link_syntax=strip_link_syntax
                        )
                        if formatting and sub_nd.get("color"):
                            sub_text = f"=={sub_text}=="
                        sub_depth = sub_nd.get("depth", 0)
                        sub_indent = indent + "  " * (sub_depth + 2)
                        lines.append(f"{sub_indent}- {sub_text}")
                elif p["values"]:
                    lines.append(f"{indent}  {p['name']}:: {', '.join(p['values'])}")
                else:
                    lines.append(f"{indent}  {p['name']}::")

    return "\n".join(lines)


def export_to_html(
    nodes: list[dict],
    resolver=None,
    layout: str = "outline",
    formatting: bool = True,
    style: str | None = None,
    properties_data: dict[str, list] | None = None,
    density: str = "comfortable",
    numbering: str = "none",
    measure: str = "full",
    doctype: str = "none",
    section_break: bool = False,
    strip_link_syntax: bool = False,
    code_class_id: str | None = None,
    quote_class_id: str | None = None,
    callout_class_map: dict[str, str] | None = None,
    theme_mode: str = "light",
    cover_page: bool = False,
    page_size: str = "a4",
    cover_metadata: dict[str, Any] | None = None,
) -> str:
    """Convert nodes to HTML format."""
    import html as html_mod

    _props = properties_data or {}

    def _id_attr(node: dict) -> str:
        uuid = node.get("uuid", "")
        return f' id="{html_mod.escape(uuid)}"' if uuid else ""

    def _render(node: dict) -> str:
        if formatting:
            return markdown_inline_to_html(
                _stringify_node(
                    node,
                    StringifyMode.PLAIN_MARKDOWN,
                    resolver,
                    html_anchors=not strip_link_syntax,
                    strip_link_syntax=strip_link_syntax,
                )
            )
        return html_mod.escape(_stringify_node(node, StringifyMode.TEXT_ONLY, resolver))

    def _title(node: dict) -> str:
        return _stringify_node(node, StringifyMode.TEXT_ONLY, resolver)

    def _color_attr(node: dict) -> str:
        color = node.get("color")
        if not color:
            return ""
        return f' style="color: {html_mod.escape(color)}"'

    def _render_subtree_html(sub_nodes: list[dict]) -> str:
        parts: list[str] = []
        current_depth = -1
        for nd in sub_nodes:
            rendered = _render(nd)
            depth = nd.get("depth", 0)
            if depth == 0:
                while current_depth >= 0:
                    parts.append("</ul>")
                    current_depth -= 1
                parts.append(f'<span class="node-property-text">{rendered}</span>')
            else:
                if depth > current_depth:
                    for _ in range(depth - current_depth):
                        parts.append('<ul class="node-property-list">')
                        current_depth += 1
                elif depth < current_depth:
                    for _ in range(current_depth - depth):
                        parts.append("</ul>")
                        current_depth -= 1
                parts.append(f"<li>{rendered}</li>")
        while current_depth >= 0:
            parts.append("</ul>")
            current_depth -= 1
        return "\n".join(parts)

    def _render_properties(node: dict) -> str:
        uuid = node.get("uuid", "")
        props = _props.get(uuid)
        if not props:
            return ""
        rows = []
        for p in props:
            name = html_mod.escape(p["name"])
            icon_html = (
                f'<span class="node-property-icon">{html_mod.escape(p["icon"])}</span> ' if p.get("icon") else ""
            )
            if p.get("subtree"):
                val_html = _render_subtree_html(p["subtree"])
            elif p["values"]:
                val_html = html_mod.escape(", ".join(p["values"]))
            else:
                val_html = '<span class="node-property-empty">—</span>'
            rows.append(
                f'<tr class="node-property"><td class="node-property-name">{icon_html}{name}</td><td class="node-property-value">{val_html}</td></tr>'
            )
        return f'<table class="node-properties">{chr(10).join(rows)}</table>'

    def _render_block(node: dict, tag: str, classes: str = "") -> str:
        rendered = _render(node)
        cls = f' class="{classes}"' if classes else ""
        return f"<{tag}{_id_attr(node)}{_color_attr(node)}{cls}>{rendered}</{tag}>"

    body_class = build_body_class(
        style, layout, density, numbering, measure, doctype, section_break, theme_mode, cover_page, page_size
    )
    style_tag = _html_style_tag(page_size)
    head_extra = f"\n{style_tag}" if style_tag else ""

    if not nodes:
        return f'<!DOCTYPE html>\n<html><head><title>Notees Export</title>{head_extra}</head><body class="{body_class}"></body></html>'

    toc_html = build_toc_html(nodes, _title, html_mod)

    def _render_flat_node(node: dict) -> str:
        rendered = _render(node)
        depth = node.get("depth", 0)
        is_page = node.get("is_page", False)
        is_code = node_is_code(node, code_class_id)
        is_quote = node_is_quote(node, quote_class_id)
        callout_type = _node_callout_type(node, callout_class_map or {})
        props_html = _render_properties(node)
        if is_page:
            level = min(depth + 1, 6)
            return (
                f"  <h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>\n  {props_html}"
                if props_html
                else f"  <h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>"
            )
        if is_heading_node(node):
            level = min(depth + 1, 6)
            if props_html:
                return f"  <h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}{props_html}</h{level}>"
            return f"  <h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>"
        if is_code:
            code_text = _stringify_node(node, StringifyMode.TEXT_ONLY, resolver)
            highlighted = _highlight_code(code_text)
            code_html = f'  <pre class="code-block"><code class="highlight">{highlighted}</code></pre>'
            return f"{code_html}\n  {props_html}" if props_html else code_html
        if callout_type:
            callout_html = f'  <blockquote class="callout callout--{callout_type}"{_id_attr(node)}{_color_attr(node)}>{rendered}</blockquote>'
            return f"{callout_html}\n  {props_html}" if props_html else callout_html
        if is_quote:
            quote_html = f"  <blockquote{_id_attr(node)}{_color_attr(node)}>{rendered}</blockquote>"
            return f"{quote_html}\n  {props_html}" if props_html else quote_html
        if props_html:
            return f"  <p{_id_attr(node)}{_color_attr(node)}>{rendered}{props_html}</p>"
        return f"  <p{_id_attr(node)}{_color_attr(node)}>{rendered}</p>"

    cover_html = _build_cover_html(cover_metadata, html_mod) if cover_page else ""
    # When a cover page is requested, the root page title is shown on the cover.
    # Skip the root page heading in the body and start with its children.
    body_nodes = nodes
    root_props_html = ""
    if cover_page and nodes and nodes[0].get("is_page"):
        body_nodes = nodes[1:]
        root_props_html = _render_properties(nodes[0])

    if layout == "flat":
        lines = [_render_flat_node(n) for n in body_nodes]
        title = _title(nodes[0]) if nodes[0].get("is_page") else "Notees Export"
        body_content = f"{toc_html}\n{chr(10).join(lines)}" if toc_html else chr(10).join(lines)
        if cover_html:
            body_content = f"{cover_html}\n{root_props_html}\n{body_content}" if root_props_html else f"{cover_html}\n{body_content}"
        return f"""<!DOCTYPE html>
<html>
<head>
<title>{html_mod.escape(title)}</title>{head_extra}
</head>
<body class="{body_class}">
{body_content}
</body>
</html>"""

    # outline — nested <ul> based on depth; page nodes break out as headings
    lines = []
    current_depth = -1
    ul_open_count = 0
    for node in body_nodes:
        rendered = _render(node)
        depth = node.get("depth", 0)
        is_page = node.get("is_page", False)
        is_code = node_is_code(node, code_class_id)
        is_quote = node_is_quote(node, quote_class_id)
        callout_type = _node_callout_type(node, callout_class_map or {})

        if is_page:
            while ul_open_count > 0:
                indent = "  " * (ul_open_count - 1)
                lines.append(f"{indent}</ul>")
                ul_open_count -= 1
                current_depth -= 1
            level = min(depth + 1, 6)
            indent = "  " * depth
            lines.append(f"{indent}<h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>")
            props_html = _render_properties(node)
            if props_html:
                lines.append(f"{indent}{props_html}")
            current_depth = depth
        else:
            if is_heading_node(node):
                while ul_open_count > 0:
                    indent = "  " * (ul_open_count - 1)
                    lines.append(f"{indent}</ul>")
                    ul_open_count -= 1
                    current_depth -= 1
                level = min(depth + 1, 6)
                indent = "  " * depth
                lines.append(f"{indent}<h{level}{_id_attr(node)}{_color_attr(node)}>{rendered}</h{level}>")
                props_html = _render_properties(node)
                if props_html:
                    lines.append(f"{indent}{props_html}")
                current_depth = depth
            elif is_code or is_quote or callout_type:
                # Code/quote/callout blocks are rendered as <li> with special inner markup
                if depth > current_depth:
                    for _ in range(depth - current_depth):
                        indent = "  " * (ul_open_count)
                        lines.append(f"{indent}<ul>")
                        ul_open_count += 1
                        current_depth += 1
                elif depth < current_depth:
                    for _ in range(current_depth - depth):
                        indent = "  " * (ul_open_count - 1)
                        lines.append(f"{indent}</ul>")
                        ul_open_count -= 1
                        current_depth -= 1
                indent = "  " * (depth + 1)
                props_html = _render_properties(node)
                if is_code:
                    code_text = _stringify_node(node, StringifyMode.TEXT_ONLY, resolver)
                    highlighted = _highlight_code(code_text)
                    inner = f'<pre class="code-block"><code class="highlight">{highlighted}</code></pre>'
                elif callout_type:
                    inner = f'<blockquote class="callout callout--{callout_type}">{rendered}</blockquote>'
                else:
                    inner = f"<blockquote>{rendered}</blockquote>"
                if props_html:
                    lines.append(
                        f'{indent}<li class="node-block"{_id_attr(node)}{_color_attr(node)}>{inner}{props_html}</li>'
                    )
                else:
                    lines.append(f'{indent}<li class="node-block"{_id_attr(node)}{_color_attr(node)}>{inner}</li>')
            else:
                if depth > current_depth:
                    for _ in range(depth - current_depth):
                        indent = "  " * (ul_open_count)
                        lines.append(f"{indent}<ul>")
                        ul_open_count += 1
                        current_depth += 1
                elif depth < current_depth:
                    for _ in range(current_depth - depth):
                        indent = "  " * (ul_open_count - 1)
                        lines.append(f"{indent}</ul>")
                        ul_open_count -= 1
                        current_depth -= 1
                indent = "  " * (depth + 1)
                props_html = _render_properties(node)
                if props_html:
                    lines.append(
                        f'{indent}<li class="node-block"{_id_attr(node)}{_color_attr(node)}>{rendered}{props_html}</li>'
                    )
                else:
                    lines.append(f'{indent}<li class="node-block"{_id_attr(node)}{_color_attr(node)}>{rendered}</li>')
    while ul_open_count > 0:
        indent = "  " * (ul_open_count - 1)
        lines.append(f"{indent}</ul>")
        ul_open_count -= 1

    body_content = f"{toc_html}\n{chr(10).join(lines)}" if toc_html else chr(10).join(lines)
    if cover_html:
        body_content = f"{cover_html}\n{root_props_html}\n{body_content}" if root_props_html else f"{cover_html}\n{body_content}"
    return f"""<!DOCTYPE html>
<html>
<head>
<title>Notees Export</title>{head_extra}
</head>
<body class="{body_class}">
{body_content}
</body>
</html>"""
