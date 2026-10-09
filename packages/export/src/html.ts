/**
 * ExportDocument IR → standalone HTML projection — the
 * reference rendering for the later paged formats (P1's PDF consumes this
 * look; D1's docx mirrors its structure), so its projection discipline
 * matches markdown.ts exactly: the IR is resolved once by
 * `buildExportDocument`; this module is a pure, IO-free projection over it.
 *
 * The output is ONE self-contained HTML document — privacy-first, nothing
 * external: no webfonts, no CDN scripts, no remote images, no <link>
 * stylesheets. The stylesheet is a single inlined <style> block whose
 * custom properties mirror the app's design tokens
 * (apps/web/src/ui/variables.css, light theme), so an exported page reads
 * like the app: warm-paper canvas, white document surface, Inter-ish sans
 * with Georgia display serif for the title. Assets are placeholders with an
 * optional path caption (single-file delivery carries no bytes; the zip
 * formats own the bytes), whiteboards and queries are pretty-printed JSON
 * <pre> blocks (whiteboard sidecar mode is markdown-bundle delivery only).
 *
 * Escaping coverage (adapts the markdown module's discipline to HTML):
 * EVERY user-derived string — text runs (including inside marks and <code>),
 * mention/chip names, verb/link/locator text, hrefs in attributes, the
 * document title (both <title> and <h1>), property schema names and values,
 * JSON payloads inside <pre> — passes through {@link escapeHtml}
 * (`& < > " '` → entities), so arbitrary content cannot break out of its
 * element or attribute. Only the deliberately-emitted syntax (element tags,
 * the `#chip` marker, the `![[uuid]]` convention) stays raw; UUIDs are
 * hex-and-dashes safe by construction.
 *
 * Token → HTML mapping:
 *
 *  | Token/IR block | HTML                                                        |
 *  |----------------|-------------------------------------------------------------|
 *  | text           | escaped; marks wrap in fixed order (outer→inner):            |
 *  |                |   bold <strong> → italic <em> → strike <del> →              |
 *  |                |   highlight <mark> → code <code> (innermost; still escaped) |
 *  | hard_break     | <br>                                                        |
 *  | mention        | <span class="mention">name</span>; when ctx.linkTarget      |
 *  |                |   resolved the file, <a class="mention" href> instead (E5)  |
 *  | class_chip     | <span class="chip">#name</span>                             |
 *  | typed_link     | <strong class="verb">verb</strong> text (locator)           |
 *  | asset_ref      | <figure class="asset"><div class="asset-box">asset · id</div>|
 *  |                |   [<figcaption>path</figcaption>]</figure> — caption only   |
 *  |                |   when ctx.assetPath resolved the bytes' bundle path (E5)   |
 *  | embed_ref      | inlined (includeEmbedded): <div class="embed"> with the     |
 *  |                |   target's blocks rendered recursively (the IR inliner is   |
 *  |                |   cycle-guarded, so recursion is safe); unresolved:          |
 *  |                |   <p class="embed-ref"> — <a href="path">name</a> when      |
 *  |                |   ctx.linkTarget resolved the file (E5), else the raw       |
 *  |                |   `![[uuid]]` text                                          |
 *  | external_link  | <a href="escaped">escaped text</a>                          |
 *  | math           | <code class="math">$expression$</code>                      |
 *  | quote          | <blockquote> with inline children                           |
 *  | query          | <pre class="query"> with the pretty-printed QueryAST JSON   |
 *  | whiteboard     | <pre class="whiteboard"> with the pretty layout JSON        |
 *  | outline cut    | <li class="cut">![[uuid]]</li> — cycle or explicit maxDepth  |
 *
 * Document shape: <head> (charset, viewport, <title>, inlined stylesheet),
 * then <body class="layout-{notes|essay|academic}"> — the layout option is
 * projected as a body class only in H1 (essay = serif + wider leading,
 * academic = two-column content via CSS columns; full theming is P1's job).
 * Inside: <header class="doc-header"> with the <h1> title for nodes that
 * render document chrome (inline blocks carry none — the markdown heading
 * discipline) plus a <dl class="properties"> when property rows (or the
 * showTypeLabels classNames line) survive the hideEmptyProperties filter;
 * <main class="content"> with the content blocks; <section class="outline">
 * with the nested-<ul> children tree when includeOutline is on.
 *
 * Print: @page margins, break-inside avoidance on every block, full-width
 * column, and external-link hrefs printed after their text.
 */

import type {
  ExportBlock,
  ExportDocument,
  ExportDocumentChild,
  ExportDocumentProperty,
  ExportSpan,
} from "./document.js";
import { isEmptyPropertyValue, qualifierTail, withoutLeadingTitle } from "./document.js";
import type { ResolvedExportOptions } from "./options.js";

// --- escaping ----------------------------------------------------------------

/**
 * Escape a user-derived string for HTML text and double-quoted attribute
 * contexts: `& < > " '` → entities. Every string originating from workspace
 * content passes through here; only deliberately-emitted element syntax
 * stays raw.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- stylesheet ----------------------------------------------------------------

/**
 * The embedded stylesheet. The package cannot import the app's CSS, so the
 * app token VALUES (apps/web/src/ui/variables.css, light theme) live here as
 * export-local `--nt-*` custom properties — the constants block below is the
 * single place a literal may appear; every rule beneath it is var()-only.
 * `--nt-highlight` has no app counterpart (the app styles highlight marks
 * per-surface); it is an export-only token chosen to read on warm paper.
 * Keep the values in sync with the app tokens when they change.
 */
const STYLESHEET = `:root {
  --nt-background: #f5f3ef;
  --nt-surface: #ffffff;
  --nt-surface-variant: #f0ede8;
  --nt-text: #1a1a1a;
  --nt-text-muted: #5c5c5c;
  --nt-accent: #404040;
  --nt-outline: #c4bfb6;
  --nt-outline-variant: #e3ded6;
  --nt-highlight: #ece4b8;
  --nt-font-sans: 'Inter', -apple-system, blinkmacsystemfont, 'Segoe UI', roboto, sans-serif;
  --nt-font-serif: georgia, 'Times New Roman', serif;
  --nt-font-mono: 'JetBrains Mono', 'Fira Code', consolas, monospace;
  --nt-content-width: 46rem;
}

* { box-sizing: border-box; }

html { background: var(--nt-background); }

body {
  margin: 0;
  background: var(--nt-surface);
  color: var(--nt-text);
  font-family: var(--nt-font-sans);
  font-size: 1rem;
  line-height: 1.6;
}

.doc-header,
.content,
.outline {
  max-width: var(--nt-content-width);
  margin: 0 auto;
  padding: 0 1.5rem;
}

.doc-header { padding-top: 2.5rem; }
.content { padding-top: 1.5rem; }
.outline { padding-top: 1rem; padding-bottom: 4rem; }

.doc-header h1 {
  margin: 0;
  font-family: var(--nt-font-serif);
  font-size: 1.75rem;
  font-weight: 600;
  line-height: 1.3;
}

.properties {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 1.25rem;
  row-gap: 0.25rem;
  margin: 1.25rem 0 0;
  padding-top: 1rem;
  border-top: 1px solid var(--nt-outline-variant);
}

.properties dt {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--nt-text-muted);
  padding-top: 0.15em;
}

.properties dd { margin: 0; }

.content p,
.content blockquote,
.content pre,
.content figure,
.content .embed { margin: 0 0 1em; }

.content a { color: var(--nt-accent); }

.content blockquote {
  padding: 0.25rem 0 0.25rem 1rem;
  border-left: 3px solid var(--nt-outline-variant);
}

.content code {
  font-family: var(--nt-font-mono);
  font-size: 0.875em;
  background: var(--nt-surface-variant);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}

.content mark { background: var(--nt-highlight); border-radius: 2px; }

.mention,
.chip {
  display: inline-block;
  padding: 0 0.5em;
  border: 1px solid var(--nt-outline-variant);
  border-radius: 9999px;
  background: var(--nt-surface-variant);
  color: var(--nt-text-muted);
  font-size: 0.875em;
  line-height: 1.5;
  text-decoration: none;
}

.embed {
  padding: 0.25rem 0 0.25rem 1rem;
  border-left: 2px solid var(--nt-outline-variant);
}

.embed-ref { color: var(--nt-text-muted); }

figure.asset { margin: 0 0 1em; }

figure.asset .asset-box {
  padding: 1.5rem 1rem;
  border: 1px dashed var(--nt-outline);
  border-radius: 8px;
  background: var(--nt-surface-variant);
  color: var(--nt-text-muted);
  font-size: 0.875rem;
  text-align: center;
}

figure.asset figcaption {
  margin-top: 0.5rem;
  color: var(--nt-text-muted);
  font-size: 0.8125rem;
  text-align: center;
  overflow-wrap: anywhere;
}

pre.query,
pre.whiteboard {
  font-family: var(--nt-font-mono);
  font-size: 0.8125rem;
  line-height: 1.5;
  background: var(--nt-surface-variant);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.outline h2 {
  margin: 2.5rem 0 0;
  padding-top: 1.5rem;
  border-top: 1px solid var(--nt-outline-variant);
  font-family: var(--nt-font-sans);
  font-size: 1.25rem;
  font-weight: 600;
  line-height: 1.4;
}

.outline ul.outline-list { margin: 0.75rem 0 0; padding-left: 1.5rem; }
.outline ul.outline-list ul.outline-list { margin-top: 0.25rem; }
.outline li { margin-bottom: 0.25rem; }
.outline li.cut { color: var(--nt-text-muted); font-family: var(--nt-font-mono); font-size: 0.875em; }
.outline li p { margin: 0 0 0.5em; }
.outline li p:last-child { margin-bottom: 0.25rem; }

/* Layout variants — H1 projects the layout option as a body class only;
   full paged-format theming is P1/D1/L1's job. */
body.layout-essay .content,
body.layout-essay .outline {
  font-family: var(--nt-font-serif);
  font-size: 1.0625rem;
  line-height: 1.8;
}
body.layout-essay .doc-header h1 { font-size: 2.25rem; font-weight: 400; }
body.layout-academic .content { columns: 2; column-gap: 2.5rem; }
@media (width <= 720px) { body.layout-academic .content { columns: 1; } }

@media print {
  @page { margin: 2cm; }
  html, body { background: var(--nt-surface); }
  .doc-header, .content, .outline { max-width: none; padding-left: 0; padding-right: 0; }
  .content p,
  .content blockquote,
  .content pre,
  .content figure,
  .content .embed { break-inside: avoid; }
  .content a[href^="http"]::after {
    content: " (" attr(href) ")";
    font-size: 0.85em;
    color: var(--nt-text-muted);
  }
}`;

// --- IR → HTML ------------------------------------------------------------------

function renderMarkedText(text: string, marks: readonly string[]): string {
  // Code is the innermost wrap and stays escaped (unlike markdown's literal
  // code spans, <code> content is parsed markup); the other marks keep the
  // fixed nesting order — innermost first: highlight, strike, italic, bold.
  let out: string = marks.includes("code") ? `<code>${escapeHtml(text)}</code>` : escapeHtml(text);
  if (marks.includes("highlight")) out = `<mark>${out}</mark>`;
  if (marks.includes("strike")) out = `<del>${out}</del>`;
  if (marks.includes("italic")) out = `<em>${out}</em>`;
  if (marks.includes("bold")) out = `<strong>${out}</strong>`;
  return out;
}

function renderSpan(span: ExportSpan): string {
  switch (span.kind) {
    case "text":
      return renderMarkedText(span.text, span.marks);
    case "hardBreak":
      return "<br>";
    case "mention":
      // Multi-file delivery (ctx.linkTarget resolved the target's file):
      // relative local link; otherwise the inert mention pill.
      return span.linkPath !== undefined
        ? `<a class="mention" href="${escapeHtml(span.linkPath)}">${escapeHtml(span.name)}</a>`
        : `<span class="mention">${escapeHtml(span.name)}</span>`;
    case "classChip":
      return `<span class="chip">#${escapeHtml(span.name)}</span>`;
    case "typedLink": {
      const locator = span.locator === null ? "" : ` (${escapeHtml(span.locator)})`;
      return `<strong class="verb">${escapeHtml(span.verb)}</strong> ${escapeHtml(span.text)}${locator}`;
    }
    case "externalLink":
      return `<a href="${escapeHtml(span.href)}">${escapeHtml(span.text)}</a>`;
    case "math":
      return `<code class="math">$${escapeHtml(span.expression)}$</code>`;
  }
}

function renderSpans(spans: readonly ExportSpan[]): string {
  return spans.map(renderSpan).join("");
}

function renderBlock(block: ExportBlock): string {
  switch (block.kind) {
    case "paragraph":
      return `<p>${renderSpans(block.spans)}</p>`;
    case "quote":
      return `<blockquote>${renderSpans(block.spans)}</blockquote>`;
    case "asset": {
      // Single-file delivery carries no bytes: a placeholder box, with the
      // bundle-relative path as a caption when ctx.assetPath resolved it.
      const box = `<div class="asset-box">asset · ${escapeHtml(block.assetId)}</div>`;
      const caption =
        block.assetPath !== undefined ? `<figcaption>${escapeHtml(block.assetPath)}</figcaption>` : "";
      return `<figure class="asset">${box}${caption}</figure>`;
    }
    case "embed":
      if (block.inlined !== null) {
        // The IR inliner is cycle-guarded, so the recursion is safe; the
        // inlined document's own outline stays markdown-bundle territory
        // (mirrors the task spec: blocks render, no nested outline).
        return `<div class="embed">${renderBlocks(block.inlined.blocks)}</div>`;
      }
      return block.link !== undefined
        ? // Multi-file delivery: the target's exported file, linked.
          `<p class="embed-ref"><a href="${escapeHtml(block.link.path)}">${escapeHtml(block.link.name)}</a></p>`
        : `<p class="embed-ref">![[${block.nodeId}]]</p>`;
    case "query":
      return `<pre class="query">${escapeHtml(JSON.stringify(block.queryAst, null, 2))}</pre>`;
    case "whiteboard":
      return `<pre class="whiteboard">${escapeHtml(JSON.stringify(block.layout, null, 2))}</pre>`;
  }
}

function renderBlocks(blocks: readonly ExportBlock[]): string {
  return blocks.map(renderBlock).join("\n");
}

// --- document chrome ------------------------------------------------------------

/** Property value + per-value qualifiers, mirroring the markdown frontmatter
 * scalar (`value (since 1962)`); null/undefined keep the visible "null"
 * placeholder when hideEmptyProperties is off. */
function renderPropertyText(property: ExportDocumentProperty): string {
  let base = property.display;
  if (base.length === 0 && (property.value === null || property.value === undefined)) {
    base = "null";
  }
  return escapeHtml(`${base}${qualifierTail(property)}`);
}

/** The properties <dl>: schemaName terms with one <dd> per value (grouped by
 * schema in first-seen order, like the frontmatter), plus the classNames
 * line when showTypeLabels is on. Empty when nothing survives the filter. */
function renderProperties(document: ExportDocument, options: ResolvedExportOptions): string {
  const rows: string[] = [];
  if (options.showTypeLabels && document.classNames.length > 0) {
    rows.push("<dt>classNames</dt>");
    for (const name of document.classNames) rows.push(`<dd>${escapeHtml(name)}</dd>`);
  }
  const visible = document.properties.filter(
    (property) => !options.hideEmptyProperties || !isEmptyPropertyValue(property.value),
  );
  const bySchema = new Map<string, typeof visible>();
  for (const property of visible) {
    const list = bySchema.get(property.schemaName);
    if (list === undefined) bySchema.set(property.schemaName, [property]);
    else list.push(property);
  }
  for (const [schemaName, values] of bySchema) {
    rows.push(`<dt>${escapeHtml(schemaName)}</dt>`);
    for (const value of values) rows.push(`<dd>${renderPropertyText(value)}</dd>`);
  }
  if (rows.length === 0) return "";
  return `<dl class="properties">\n${rows.join("\n")}\n</dl>`;
}

function renderHeader(document: ExportDocument, options: ResolvedExportOptions): string {
  const parts: string[] = [];
  // Document-chrome discipline mirrors markdown: inline blocks (parented,
  // render bit unset) carry no visible title heading — the <title> element
  // alone labels the document.
  if (document.rendersDocumentChrome) {
    const heading = document.title.length > 0 ? document.title : document.nodeId;
    parts.push(`<h1>${escapeHtml(heading)}</h1>`);
  }
  const properties = renderProperties(document, options);
  if (properties.length > 0) parts.push(properties);
  if (parts.length === 0) return "";
  return `<header class="doc-header">\n${parts.join("\n")}\n</header>`;
}

// --- outline ---------------------------------------------------------------------

/** Cut entries (cycle / explicit maxDepth) render the visible `![[uuid]]`
 * reference, never a silent drop. */
function renderOutlineList(children: readonly ExportDocumentChild[]): string {
  const items = children
    .map((child) => {
      if (child.cut !== undefined) {
        return `<li class="cut">![[${child.id}]]</li>`;
      }
      const inner: string[] = [];
      if (child.blocks.length > 0) inner.push(renderBlocks(child.blocks));
      if (child.children.length > 0) inner.push(renderOutlineList(child.children));
      return `<li>\n${inner.join("\n")}\n</li>`;
    })
    .join("\n");
  return `<ul class="outline-list">\n${items}\n</ul>`;
}

// --- document ---------------------------------------------------------------------

/**
 * Serialize a built {@link ExportDocument} to one complete, standalone HTML
 * document: inlined stylesheet, document header (title + properties), the
 * content blocks (minus the leading title span when it rides in the <h1> —
 * the single-title rule), and — unless includeOutline left the IR without
 * children — the nested-<ul> outline. Everything is inlined; no external
 * resource is ever referenced (privacy-first single file).
 */
export function renderExportDocumentToHtml(
  document: ExportDocument,
  options: ResolvedExportOptions,
): string {
  const title = document.title.length > 0 ? document.title : document.nodeId;
  const body: string[] = [];
  const header = renderHeader(document, options);
  if (header.length > 0) body.push(header);
  body.push(`<main class="content">\n${renderBlocks(withoutLeadingTitle(document))}\n</main>`);
  if (document.children.length > 0) {
    body.push(`<section class="outline">\n<h2>Outline</h2>\n${renderOutlineList(document.children)}\n</section>`);
  }
  const parts = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>\n${STYLESHEET}\n</style>`,
    "</head>",
    `<body class="layout-${options.layout}">`,
    ...body,
    "</body>",
    "</html>",
  ];
  return `${parts.join("\n")}\n`;
}
