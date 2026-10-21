/**
 * Markdown-link splitting for plain text tokens — the canonical parser for
 * the retired `external_link` token's replacement (SCHEMA.md content
 * grammar: links live as markdown `[label](href)` spans inside `text`
 * tokens, parsed at render time). Shared by the web renderer (InlineTokens)
 * and the export serializers (markdown/html/latex) so every surface linkifies
 * identically; GTK and Flutter port this grammar per SCHEMA.md.
 *
 * Imports and external writers can only place raw text in a page title (the
 * store flattens rich tokens on document-chrome nodes), so this shape is the
 * one link format that survives every boundary. The parse is deliberately
 * conservative: the label holds no `]` or newline, the href holds no
 * whitespace or parentheses, and only http/https/mailto hrefs become
 * anchors — anything else (unclosed brackets, `javascript:` schemes,
 * relative paths) stays literal text, never a link.
 */

export type MarkdownTextSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;

function linkableHref(href: string): string | null {
  // Scheme allow-list — the security-relevant part of the decision: a
  // non-http(s)/mailto href must never become a clickable anchor (a
  // `javascript:` href in an <a> attribute is executable on click).
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

export function splitMarkdownLinks(text: string): MarkdownTextSegment[] {
  const segments: MarkdownTextSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    MARKDOWN_LINK_RE.lastIndex = cursor;
    const match = MARKDOWN_LINK_RE.exec(text);
    if (match === null) break;
    const raw = match[0];
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    if (match.index > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    const safeHref = linkableHref(href);
    if (safeHref !== null) {
      segments.push({ kind: "link", text: label, href: safeHref });
    } else {
      segments.push({ kind: "text", text: raw });
    }
    cursor = match.index + raw.length;
  }
  if (segments.length === 0) return [{ kind: "text", text }];
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
