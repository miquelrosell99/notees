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
 * relative paths) stays literal text, never a link. After the markdown
 * pass, remaining text segments are scanned for bare `http(s)://` URLs and
 * linkified too (trailing sentence punctuation and unbalanced closing
 * parens/brackets trimmed off the match).
 */

export type MarkdownTextSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;

// The image form of the markdown span — flattened to its ALT text by
// flattenMarkdownLinks (the display-name flatten); deliberately NOT part
// of splitMarkdownLinks' linkify pass (there is no image token in the
// render grammar — a `![alt](src)` span in a text token renders literally
// there, the renderer's own concern).
const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(([^()\s]+)\)/g;

// Deliberately generous — balanced parens may ride inside the URL (the
// trailing-trim pass strips the unbalanced ones a closing sentence paren
// would otherwise swallow).
const BARE_URL_RE = /https?:\/\/[^\s<>"']+/gi;

function linkableHref(href: string): string | null {
  // Scheme allow-list — the security-relevant part of the decision: a
  // non-http(s)/mailto href must never become a clickable anchor (a
  // `javascript:` href in an <a> attribute is executable on click).
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

function countChar(text: string, ch: string): number {
  let count = 0;
  for (const c of text) if (c === ch) count += 1;
  return count;
}

/** Trim sentence punctuation and unbalanced closers off a matched bare URL. */
function trimBareUrlTail(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1]!;
    if (".,;:!?=".includes(last)) {
      end -= 1;
      continue;
    }
    if (
      (last === ")" && countChar(raw.slice(0, end), ")") > countChar(raw.slice(0, end), "(")) ||
      (last === "]" && countChar(raw.slice(0, end), "]") > countChar(raw.slice(0, end), "["))
    ) {
      end -= 1;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

function splitBareUrls(text: string): MarkdownTextSegment[] {
  const segments: MarkdownTextSegment[] = [];
  let cursor = 0;
  BARE_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_URL_RE.exec(text)) !== null) {
    const href = trimBareUrlTail(match[0]);
    // The trim can leave a bare scheme (e.g. `https://)`) — never link that.
    if (!/^https?:\/\/[^/?#]+/i.test(href)) continue;
    if (match.index > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    segments.push({ kind: "link", text: href, href });
    // The trimmed tail (punctuation, unbalanced closers) re-enters the text
    // stream — advance only past the href itself.
    cursor = match.index + href.length;
  }
  if (segments.length === 0) return [{ kind: "text", text }];
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

export function splitMarkdownLinks(text: string): MarkdownTextSegment[] {
  const markdownSegments: MarkdownTextSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    MARKDOWN_LINK_RE.lastIndex = cursor;
    const match = MARKDOWN_LINK_RE.exec(text);
    if (match === null) break;
    const raw = match[0];
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    if (match.index > cursor) {
      markdownSegments.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    const safeHref = linkableHref(href);
    if (safeHref !== null) {
      markdownSegments.push({ kind: "link", text: label, href: safeHref });
    } else {
      markdownSegments.push({ kind: "text", text: raw });
    }
    cursor = match.index + raw.length;
  }
  if (markdownSegments.length === 0) markdownSegments.push({ kind: "text", text });
  else if (cursor < text.length) markdownSegments.push({ kind: "text", text: text.slice(cursor) });

  // Bare-URL autolink: markdown-link labels and hrefs never reach this pass
  // (the markdown pass consumed them whole), so scanning the remaining text
  // segments cannot linkify inside a markdown link.
  const segments: MarkdownTextSegment[] = [];
  for (const segment of markdownSegments) {
    if (segment.kind === "link") {
      segments.push(segment);
      continue;
    }
    segments.push(...splitBareUrls(segment.text));
  }
  return segments;
}

/**
 * Flatten markdown link/image spans in a plain-text run to their visible
 * text — the display-name flatten (title-is-content): `[label](href)` →
 * `label`, `![alt](src)` → `alt`. The image pass runs first (an image's
 * `!` prefix would otherwise survive as literal text before the link
 * match); then the link grammar reduces each span, keeping non-linkable
 * hrefs and unmatched brackets literal. Bare URLs are already text — they
 * pass through segment-for-segment.
 */
export function flattenMarkdownLinks(text: string): string {
  const withoutImages = text.replace(MARKDOWN_IMAGE_RE, (_match, alt: string) => alt);
  return splitMarkdownLinks(withoutImages)
    .map((segment) => segment.text)
    .join("");
}
