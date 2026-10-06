/**
 * Content tokens → Markdown projection (SCHEMA.md owed work "Content
 * serialization for export", Tier 2 conventions), hardened per the
 * export-redesign pass.
 *
 * The op log is the truth; this is a lossy, human-facing projection:
 * UUID-or-slug filenames, YAML frontmatter (name/isClass/presentAsMain/
 * classes/properties), `[[mentions]]`, `#class-chips`, `![[uuid]]` embeds,
 * fenced ```query / ```json whiteboard blocks, and a workspace
 * UUID↔name↔type manifest (bundle.ts).
 *
 * Rendering is IR-based: `buildExportDocument` (document.ts) resolves the
 * node subtree once (names, outline tree, embed inlining, class labels);
 * `renderExportDocumentToMarkdown` projects the IR to text. Escaping is ON
 * by default: every user-derived string (text runs, mention/chip/verb/link
 * text, the heading title) is escaped so arbitrary content cannot corrupt
 * the document — while the deliberately-emitted syntax (`[[…]]`, `#chip`,
 * fences, `![[uuid]]`) is never escaped.
 *
 * Escaping coverage (documented, closes the SCHEMA.md "metacharacter
 * escaping" deferral):
 *
 *  - Inline specials everywhere in text runs: `\ ` `` ` `` `*` `_` `~`
 *    `[` `]` `<` `>` → backslash-escaped. Code-marked runs are the exception:
 *    a code span is literal, so only backticks are swapped (kept behavior).
 *  - Line starts (a run's first line, lines after an interior newline, and
 *    runs following a hard break): ATX `#`, blockquote `>`, bullet `-`/`+`,
 *    ordered-list delimiters (`1.` → `1\.`), thematic-break/setext/highlight
 *    runs (`---`, `===`, `==…`) get their first marker escaped. Backtick and
 *    tilde fences cannot form (both chars always escaped).
 *  - `[[mention]]` names: `]` and `\` escaped inside the brackets.
 *  - `#chip` names: `\` escaped (whitespace folds to `-`, leading `#`
 *    stripped — the chip convention itself is emitted deliberately).
 *  - `**verb**` verbs and typed-link text: the inline-special set. Locators
 *    escape `\` and `)` so `(…)` cannot break. External-link text escapes
 *    the inline set; hrefs stay bare when URL-safe, otherwise they are
 *    wrapped in `<…>` with whitespace/parens/brackets percent-encoded.
 *  - Fences are lengthened past any backtick run inside query/whiteboard
 *    JSON payloads, so a ``` inside a string can never close the fence.
 *
 * Closure: the child outline renders the WHOLE tree by default (the retired
 * `MAX_CHILD_DEPTH` silent truncation is gone); the only cuts are visible —
 * embed-style cycles and an explicit `maxDepth` hit render as `![[uuid]]`
 * bullets. Whiteboards: `whiteboardMode: "inline"` (single-file default)
 * keeps the fenced ```json block; `"sidecar"` emits a file link that
 * `bundleMarkdown` backs with a `<uuid>.whiteboard.json` sidecar (the
 * "whiteboards → sidecar JSON + file link" convention).
 *
 * Token → Markdown mapping:
 *
 *  | Token/IR block | Markdown                                              |
 *  |----------------|-------------------------------------------------------|
 *  | text           | escaped (above); marks wrap in fixed order (outer→inner):|
 *  |                |   bold `**` → italic `*` → strike `~~` →              |
 *  |                |   highlight `==` → code `` ` `` (innermost; literal)  |
 *  | hard_break     | newline (line jump)                                   |
 *  | mention        | `[[name]]` — displayText ?? ctx.nameOf(target) ?? raw id    |
 *  |                |   (broken targets render the id; SCHEMA Fork 4); when       |
 *  |                |   ctx.linkTarget resolves the target's exported file,       |
 *  |                |   `[name](<path>)` instead (multi-file/zip delivery)    |
 *  | class_chip     | `#name` — displayText ?? ctx.nameOf(class) ?? raw id;  |
 *  |                |   whitespace collapsed to `-`, leading `#` stripped    |
 *  | typed_link     | `**verb** text (locator)` — verb string, or bound      |
 *  |                |   propertySchemaId resolved via ctx.nameOf; locator   |
 *  |                |   from metadata.locator, plain parentheses            |
 *  | asset_ref      | `![asset](<uuid>)`; when ctx.assetPath resolves the    |
 *  |                |   bundle-relative bytes path, `![asset](<path>)`        |
 *  | embed_ref      | `![[uuid]]`, or the target's rendered content when    |
 *  |                |   includeEmbedded resolves it via ctx.nodeOf; when    |
 *  |                |   unresolved and ctx.linkTarget knows the file,       |
 *  |                |   `[name](<path>)`                                    |
 *  | external_link  | `[text](href)` — href bare when safe, else `<…>`       |
 *  | math           | `$expression$`                                        |
 *  | quote          | `> ` prefix per rendered line (children inline)        |
 *  | query          | fenced ```query block, pretty-printed QueryAST JSON    |
 *  | whiteboard     | fenced ```json block (inline), or `[whiteboard](<path>)`|
 *  |                |   backed by a sidecar file in sidecar mode             |
 *  | outline cut    | `- ![[uuid]]` — cycle or explicit maxDepth (visible)   |
 *
 * Block-scale tokens (asset/embed/query/whiteboard) always render as their
 * own paragraph (a kept simplification). The package is pure/IO-free:
 * name, node, and child resolution are injected via ExportContext.
 */

import type { ContentAst } from "@notees/protocol";

import type {
  ExportBlock,
  ExportDocument,
  ExportDocumentChild,
  ExportNode,
  ExportPropertyValue,
  ExportSpan,
} from "./document.js";
import {
  buildExportBlocks,
  buildExportDocument,
  isEmptyPropertyValue,
  whiteboardSidecarPath,
  withoutLeadingTitle,
} from "./document.js";
import type { ExportContext } from "./document.js";
import { qualifierDisplayOf } from "./document.js";
import type { ExportOptions, ResolvedExportOptions } from "./options.js";
import { resolveExportOptions } from "./options.js";

// --- escaping ----------------------------------------------------------------

/** Chars that change inline parsing no matter where they appear. */
const INLINE_SPECIALS = /([\\`*_[\]<>~])/g;

function escapeInlineSpecials(text: string): string {
  return text.replace(INLINE_SPECIALS, "\\$1");
}

/**
 * Escape a user-derived text run for inline Markdown. `atLineStart` marks
 * runs that open a line (first span of a paragraph, or one right after a
 * hard break); interior newlines make every following line a line start.
 */
export function escapeMarkdownText(text: string, atLineStart = false): string {
  const escaped = escapeInlineSpecials(text);
  const lines = escaped.split("\n");
  for (let index = atLineStart ? 0 : 1; index < lines.length; index += 1) {
    lines[index] = escapeLineStart(lines[index] ?? "");
  }
  return lines.join("\n");
}

/** Block constructs only bite at line start — neutralize their first marker. */
function escapeLineStart(line: string): string {
  let match: RegExpExecArray | null;
  if ((match = /^(\d{1,9})([.)])([ \t])/.exec(line)) !== null) {
    // Digits are not escapable punctuation — escape the list delimiter and
    // re-emit the separator the match consumed.
    return `${match[1] ?? ""}\\${match[2] ?? ""}${match[3] ?? ""}${line.slice(match[0].length)}`;
  }
  if (/^(?:#{1,6}(?:[ \t]|$)|>|[-+][ \t]|[-=]{3,}[ \t]*$|==)/.test(line)) {
    return `\\${line}`;
  }
  return line;
}

/** `]` or `\` inside a `[[…]]` name would close or inject — escape both. */
function escapeMentionName(name: string): string {
  return name.replace(/([\\\]])/g, "\\$1");
}

/** Chip names keep the `#name` convention; only backslashes are escaped. */
function escapeChipName(name: string): string {
  return name.replace(/\\/g, "\\\\");
}

/** A `(…)` locator cannot contain a raw `)` or backslash. */
function escapeLocator(locator: string): string {
  return locator.replace(/([\\)])/g, "\\$1");
}

/** External-link display text lives inside `[…]`. */
function escapeLinkText(text: string): string {
  return escapeInlineSpecials(text);
}

/**
 * Link destination: bare when URL-safe, otherwise `<…>` with whitespace,
 * parens, angle brackets, and backslashes percent-encoded.
 */
function renderHref(href: string): string {
  if (/^[^\s()<>\x00-\x1f\x7f\\]+$/.test(href)) return href;
  const encoded = href
    .replace(/[()]/g, (ch) => (ch === "(" ? "%28" : "%29"))
    .replace(/[<>\\]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/[\s\x00-\x1f\x7f]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `<${encoded}>`;
}

// --- YAML frontmatter ---------------------------------------------------------

/** Plain-scalar safe subset; anything else is emitted as a JSON (YAML double-quoted) string. */
const YAML_PLAIN = /^[A-Za-z0-9][A-Za-z0-9 ._/@()+\-]*$/;
const YAML_RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

function yamlScalar(value: string): string {
  if (YAML_PLAIN.test(value) && !YAML_RESERVED.has(value.toLowerCase())) return value;
  return JSON.stringify(value);
}

function yamlKey(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_ -]*$/.test(name) ? name : JSON.stringify(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Property row → frontmatter scalar: metadata qualifiers appended here;
 * hideEmptyProperties OFF still shows a placeholder for null/undefined. */
function renderPropertyScalar(property: ExportPropertyValue & { display: string }): string {
  let base = property.display;
  if (base.length === 0 && (property.value === null || property.value === undefined)) {
    base = "null";
  }
  const metadata = property.metadata;
  if (metadata !== undefined && Object.keys(metadata).length > 0) {
    const qualifiers = Object.entries(metadata)
      .map(([key, entry]) => `${key} ${qualifierDisplayOf(entry)}`)
      .join(", ");
    base = `${base} (${qualifiers})`;
  }
  return yamlScalar(base);
}

/** A date_range row's two end labels (null = open side), when it is one. */
function rangeEnds(property: ExportPropertyValue): Array<string | null> | null {
  if (!isRecord(property.value) || "nodeId" in property.value) return null;
  if (!("start" in property.value) && !("end" in property.value)) return null;
  const entries = (property as { displayEntries?: Array<string | null> }).displayEntries;
  if (entries !== undefined && entries.length === 2) return entries;
  return null;
}

function renderRangeEnd(label: string | null): string {
  return label === null ? "null" : yamlScalar(label);
}

function renderFrontmatter(document: ExportDocument, options: ResolvedExportOptions): string {
  const lines: string[] = ["---"];
  if (document.title.length > 0) lines.push(`name: ${yamlScalar(document.title)}`);
  lines.push(`isClass: ${document.isClass ? "true" : "false"}`);
  lines.push(`presentAsMain: ${document.presentAsMain ? "true" : "false"}`);
  if (document.classIds.length > 0) {
    lines.push("classIds:");
    for (const classId of document.classIds) lines.push(`  - ${yamlScalar(classId)}`);
  }
  if (options.showTypeLabels && document.classNames.length > 0) {
    lines.push("classNames:");
    for (const name of document.classNames) lines.push(`  - ${yamlScalar(name)}`);
  }
  const properties = document.properties.filter(
    (property) => !options.hideEmptyProperties || !isEmptyPropertyValue(property.value),
  );
  if (properties.length > 0) {
    const bySchema = new Map<string, typeof properties>();
    for (const property of properties) {
      const list = bySchema.get(property.schemaName);
      if (list === undefined) bySchema.set(property.schemaName, [property]);
      else list.push(property);
    }
    lines.push("properties:");
    for (const [schemaName, values] of bySchema) {
      if (values.length === 1) {
        const only = values[0];
        if (only === undefined) continue;
        // PG15 per-type branches: date_range rows emit a start/end map,
        // multi-value arrays emit one YAML item per element (labels, not raw
        // JSON); everything else stays a scalar.
        const ends = rangeEnds(only);
        if (ends !== null) {
          lines.push(`  ${yamlKey(schemaName)}:`);
          lines.push(`    start: ${renderRangeEnd(ends[0] ?? null)}`);
          lines.push(`    end: ${renderRangeEnd(ends[1] ?? null)}`);
          continue;
        }
        const entries = (only as { displayEntries?: string[] }).displayEntries;
        if (Array.isArray(only.value) && only.value.length > 0 && entries !== undefined) {
          lines.push(`  ${yamlKey(schemaName)}:`);
          for (const entry of entries) lines.push(`    - ${yamlScalar(entry)}`);
          continue;
        }
        lines.push(`  ${yamlKey(schemaName)}: ${renderPropertyScalar(only)}`);
      } else {
        lines.push(`  ${yamlKey(schemaName)}:`);
        for (const value of values) {
          const ends = rangeEnds(value);
          if (ends !== null) {
            lines.push(`    - start: ${renderRangeEnd(ends[0] ?? null)}`);
            lines.push(`      end: ${renderRangeEnd(ends[1] ?? null)}`);
            continue;
          }
          lines.push(`    - ${renderPropertyScalar(value)}`);
        }
      }
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// --- IR → markdown --------------------------------------------------------------

/** Fence long enough that no backtick run inside the payload can close it. */
function fenced(info: string, payload: string): string {
  let longest = 0;
  for (const match of payload.matchAll(/`+/g)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${payload}\n${fence}`;
}

function renderMarkedText(text: string, marks: readonly string[], atLineStart: boolean): string {
  // Code spans are literal: no markdown escaping inside (backticks swapped).
  // Code is always the innermost wrap; the other marks keep the fixed
  // nesting order — innermost first: highlight, strike, italic, bold.
  let out: string = marks.includes("code")
    ? `\`${text.replace(/`/g, "'")}\``
    : escapeMarkdownText(text, atLineStart);
  if (marks.includes("highlight")) out = `==${out}==`;
  if (marks.includes("strike")) out = `~~${out}~~`;
  if (marks.includes("italic")) out = `*${out}*`;
  if (marks.includes("bold")) out = `**${out}**`;
  return out;
}

function renderSpan(span: ExportSpan, atLineStart: boolean): string {
  switch (span.kind) {
    case "text":
      return renderMarkedText(span.text, span.marks, atLineStart);
    case "hardBreak":
      return "\n";
    case "mention":
      // Multi-file delivery (ctx.linkTarget resolved the target's file):
      // relative local link; otherwise the [[name]] wikilink convention.
      return span.linkPath !== undefined
        ? `[${escapeLinkText(span.name)}](${renderHref(span.linkPath)})`
        : `[[${escapeMentionName(span.name)}]]`;
    case "classChip":
      return `#${escapeChipName(span.name)}`;
    case "typedLink": {
      const locator = span.locator === null ? "" : ` (${escapeLocator(span.locator)})`;
      return `**${escapeMarkdownText(span.verb)}** ${escapeMarkdownText(span.text)}${locator}`;
    }
    case "externalLink":
      return `[${escapeLinkText(span.text)}](${renderHref(span.href)})`;
    case "math":
      return `$${span.expression}$`;
  }
}

/** Render one paragraph's spans; `atLineStart` seeds the first text run. */
function renderSpans(spans: readonly ExportSpan[]): string {
  let lineStart = true;
  const parts: string[] = [];
  for (const span of spans) {
    parts.push(renderSpan(span, lineStart));
    lineStart = span.kind === "hardBreak";
  }
  return parts.join("");
}

/**
 * Render a block list to Markdown lines. `ownerId` names the node whose
 * stream this is — whiteboard sidecar links derive from it, and the k-th
 * whiteboard block in THIS stream gets sidecar index k (mirrored by
 * `listWhiteboardBlocks` in the bundle emitter).
 */
function renderBlocksToLines(
  blocks: readonly ExportBlock[],
  ownerId: string,
  options: ResolvedExportOptions,
): string[] {
  const lines: string[] = [];
  let whiteboardIndex = 0;
  for (const block of blocks) {
    let text: string;
    switch (block.kind) {
      case "paragraph":
        text = renderSpans(block.spans);
        break;
      case "quote": {
        const inner = renderSpans(block.spans);
        text = inner
          .split("\n")
          .map((lineText) => `> ${lineText}`.trimEnd())
          .join("\n");
        break;
      }
      case "asset":
        // ctx.assetPath resolved the bundle-relative bytes path; otherwise
        // the raw CAS uuid reference stands.
        text =
          block.assetPath !== undefined
            ? `![asset](${renderHref(block.assetPath)})`
            : `![asset](<${block.assetId}>)`;
        break;
      case "embed":
        text =
          block.inlined !== null
            ? renderInlinedEmbed(block.inlined, options)
            : block.link !== undefined
              ? // Multi-file delivery: the target's exported file, linked.
                `[${escapeLinkText(block.link.name)}](${renderHref(block.link.path)})`
              : `![[${block.nodeId}]]`;
        break;
      case "query":
        text = fenced("query", JSON.stringify(block.queryAst, null, 2));
        break;
      case "whiteboard":
        if (options.whiteboardMode === "sidecar") {
          text = `[whiteboard](<${whiteboardSidecarPath(ownerId, whiteboardIndex)}>)`;
          whiteboardIndex += 1;
        } else {
          text = fenced("json", JSON.stringify(block.layout, null, 2));
        }
        break;
    }
    if (text.trim().length > 0) lines.push(text);
  }
  return lines;
}

/** Inlined embed (includeEmbedded): the target's blocks, then its outline
 * indented one level under the embed point. No frontmatter/heading — the
 * content lives inside the host document. */
function renderInlinedEmbed(document: ExportDocument, options: ResolvedExportOptions): string {
  const lines = renderBlocksToLines(document.blocks, document.nodeId, options);
  if (document.children.length > 0) {
    lines.push(...renderChildBulletLines(document.children, options, 0).map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

/** Outline tree → nested bullets; cut entries render the visible `![[uuid]]`. */
function renderChildBulletLines(
  children: readonly ExportDocumentChild[],
  options: ResolvedExportOptions,
  depth: number,
): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const child of children) {
    if (child.cut !== undefined) {
      lines.push(`${indent}- ![[${child.id}]]`);
      continue;
    }
    // Block entries may carry hard-break line jumps — split to physical
    // lines so continuations pick up the bullet indent.
    const contentLines = renderBlocksToLines(child.blocks, child.id, options).flatMap((line) =>
      line.split("\n"),
    );
    const first = contentLines[0] ?? "";
    lines.push(`${indent}- ${first}`.trimEnd());
    for (const rest of contentLines.slice(1)) {
      lines.push(`${indent}  ${rest}`.trimEnd());
    }
    lines.push(...renderChildBulletLines(child.children, options, depth + 1));
  }
  return lines;
}

/**
 * Serialize a built {@link ExportDocument} to a standalone Markdown file:
 * YAML frontmatter, the `# <title>` heading for every node with document
 * chrome (inline blocks carry none), the rendered content — minus the
 * leading title span when it rides in the heading (the single-title rule,
 * {@link withoutLeadingTitle}) — and, unless includeOutline is off, the
 * nested-bullets outline.
 */
export function renderExportDocumentToMarkdown(
  document: ExportDocument,
  options: ResolvedExportOptions,
): string {
  const parts: string[] = [renderFrontmatter(document, options)];
  if (document.rendersDocumentChrome) {
    const heading = document.title.length > 0 ? escapeMarkdownText(document.title) : document.nodeId;
    parts.push(`# ${heading}`);
  }
  const bodyLines = renderBlocksToLines(withoutLeadingTitle(document), document.nodeId, options);
  if (bodyLines.length > 0) parts.push(bodyLines.join("\n"));
  if (document.children.length > 0) {
    const childLines = renderChildBulletLines(document.children, options, 0);
    if (childLines.length > 0) parts.push(childLines.join("\n"));
  }
  return parts.join("\n\n") + "\n";
}

/**
 * Render one node (and, via the injected resolver, its subtree) to a
 * standalone Markdown file. `options` optional — defaults are the hardened
 * E2 behavior (escaping ON, full closure, empty properties hidden).
 */
export function nodeToMarkdown(node: ExportNode, ctx: ExportContext, options?: ExportOptions): string {
  const resolved = resolveExportOptions(options);
  return renderExportDocumentToMarkdown(buildExportDocument(node, ctx, resolved), resolved);
}

/**
 * Render a raw token stream to Markdown lines (no frontmatter/heading/outline
 * — the seam the bundle's child bullets and external callers use). Kept from
 * the pre-IR API; now a thin IR-blocks projection.
 */
export function renderContent(ast: ContentAst | null | undefined, ctx: ExportContext): string {
  const blocks = buildExportBlocks(ast, ctx);
  return renderBlocksToLines(blocks, "renderContent", resolveExportOptions()).join("\n");
}
