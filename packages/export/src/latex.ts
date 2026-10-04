/**
 * ExportDocument IR → LaTeX projection (§34.24 task L1) — an
 * escaping-correct template serializer emitting one complete, compilable
 * `.tex` document. Pure and IO-free like every serializer in this package:
 * the output is source text the caller delivers however it chooses; no bytes
 * are ever bundled (single-file delivery — asset blocks are placeholders,
 * see below).
 *
 * The layout option (§34.24 modelling decision 5: LaTeX gets
 * article/two-column class variants — LaTeX has no "Notes/Essay" theme)
 * projects to the documentclass only: "notes"/"essay" → one-column
 * `article`, "academic" → `twocolumn` (the `thebibliography` then typesets
 * two-column-friendly under the same class option; there is no per-layout
 * markup beyond `\documentclass`). `pageFormat` is pdf-gated, so the
 * template fixes A4 via geometry (the same "A4 fixed" call D1 makes).
 *
 * Preamble (portable set, no external resource includes): fontenc[T1],
 * geometry (A4, 2.5cm margins), amsmath (math spans), xcolor (highlight
 * boxes + the export-local `noteeshighlight` color, mirroring the HTML
 * export's `--nt-highlight` token), ulem WITH `[normalem]` (strike — the
 * option is load-bearing: bare ulem redefines `\emph` to underline, which
 * would corrupt italic spans), hyperref[hidelinks] (external links), loaded
 * last per convention. Paragraphs are set block-style (`\parindent` 0,
 * `\parskip`) to read like the app/markdown exports instead of indented
 * academic prose.
 *
 * Escaping (the load-bearing piece): EVERY user-derived string — text runs
 * (including inside marks, `\texttt`, `\href`), mention/chip names, verb /
 * typed-link / locator text, hrefs, the document title, property schema
 * names, values and qualifiers, asset ids and paths, bibliography fields —
 * passes through {@link escapeLatex}:
 *
 *  | Char | Macro                       | Char | Macro                |
 *  |------|-----------------------------|------|----------------------|
 *  | `\`  | `\textbackslash{}`         | `}`  | `\}`                 |
 *  | `%`  | `\%`                        | `~`  | `\textasciitilde{}`  |
 *  | `&`  | `\&`                        | `^`  | `\textasciicircum{}` |
 *  | `_`  | `\_`                        | `#`  | `\#`                 |
 *  | `{`  | `\{`                        | `$`  | `\$`                 |
 *
 * The replacement is a single regex pass, so replacements can never
 * re-escape characters introduced by earlier ones (sequential replaces
 * would corrupt `\textbackslash{}`'s braces); all macros are kernel
 * text-mode constructs (no package needed). Deliberately-emitted syntax
 * (`#chip`, `[[name]]`, `![[uuid]]`, the multi-file `[name](path)`
 * convention, environment/framework markup) stays raw; UUIDs are
 * hex-and-dashes safe by construction. Two exceptions:
 * math span expressions pass through VERBATIM inside `$…$` (math is
 * authored LaTeX, not prose — escaping it would corrupt it), and
 * query/whiteboard payloads are typeset in `verbatim`, which is raw by
 * design (a JSON string containing a line that is exactly `\end{verbatim}`
 * could break out — accepted, documented, same "human-opaque projection"
 * tier as the other serializers).
 *
 * The E5 multi-file hooks do not link-project in v1: the `.tex` is a
 * single file, so a mention/embed whose target file was resolved renders
 * the `[name](path)` text convention (the path points at another export's
 * file, not at a resource the document includes), and a resolved
 * `assetPath` prints inside the asset placeholder box — `\includegraphics`
 * is deliberately NOT emitted: it would need the bytes plus a relative
 * layout the package cannot know (single-file delivery carries no assets).
 *
 * Token → LaTeX mapping:
 *
 *  | Token/IR block | LaTeX                                                       |
 *  |----------------|-------------------------------------------------------------|
 *  | text           | escaped; marks wrap in fixed order (outer→inner):           |
 *  |                |   bold `\textbf` → italic `\emph` → strike `\sout` (ulem) → |
 *  |                |   highlight `\colorbox{noteeshighlight}` → code `\texttt`   |
 *  |                |   (innermost; still escaped — unlike markdown's literal      |
 *  |                |   code spans, `\texttt` content is parsed)                  |
 *  | hard_break     | `\\` line break                                             |
 *  | mention        | escaped name; multi-file hook resolved: `[name](path)`      |
 *  | class_chip     | `#name` (escaped)                                           |
 *  | typed_link     | `\textbf{verb} text (locator)` — all escaped                |
 *  | external_link  | `\href{escaped url}{escaped text}` (hyperref)               |
 *  | math           | `$expression$` VERBATIM (authored LaTeX)                    |
 *  | quote          | `quote` environment with the inline children                |
 *  | asset_ref      | `\fbox{\parbox{0.9\linewidth}{Asset: \texttt{id}}}`         |
 *  |                |   placeholder; resolved assetPath prints on a second line   |
 *  | embed_ref      | inlined (includeEmbedded): the target's blocks recursively  |
 *  |                |   (cycle-guarded by the IR builder); unresolved: the raw    |
 *  |                |   `![[uuid]]` text, or `[name](path)` when the link hook    |
 *  |                |   resolved the target's file                                |
 *  | query          | `verbatim` environment, pretty-printed QueryAST JSON        |
 *  | whiteboard     | `verbatim` environment, pretty layout JSON                  |
 *  | outline cut    | `\item ![[uuid]]` — cycle or explicit maxDepth (visible)    |
 *
 * Document shape: preamble, then the title as `\section*{…}` for nodes with
 * document chrome (the markdown/html predicate; inline blocks carry none —
 * no `\maketitle`, no `\title`), property rows as run-in
 * `\paragraph*{schemaName} value` paragraphs (multi-value schemas join with
 * `; `, per-value qualifiers keep the `value (since 1962)` convention,
 * hideEmptyProperties/showTypeLabels honored like the other serializers),
 * the content blocks, an `\section*{Outline}` + nested `itemize` tree when
 * the IR carries children (the catalog gates the UI checkbox to
 * markdown/pdf/docx/html, but the serializer consumes whatever the IR
 * builder resolved — includeOutline defaults ON), and finally the
 * bibliography.
 *
 * Bibliography: every exported node the CSL predicate recognizes as a
 * source is projected through `nodeToCsl` (csl.ts — the exact source
 * detection the BibTeX/CSL path uses, not a parallel predicate) and
 * emitted as `\bibitem{<citekey-or-node-id>}` inside one `thebibliography`
 * environment, rendered "Authors (Year). `\emph{Title}`." composed from the
 * CSL record via csl.ts `formatAuthors`. The collection walks the exported
 * nodes in encounter order — the root, inlined embed documents (their own
 * embeds and outline children recurse), then the outline children
 * depth-first — deduped by node id. The environment is emitted only when at
 * least one source exists (an export without sources compiles to a document
 * with no bibliography, like a document without `\cite`s).
 */

import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { ExportBlock, ExportDocument, ExportDocumentChild, ExportDocumentProperty, ExportSpan } from "./document.js";
import { isEmptyPropertyValue, qualifierDisplayOf } from "./document.js";
import type { CslItem } from "./csl.js";
import { formatAuthors, nodeToCsl, sourceClassOf } from "./csl.js";
import type { ResolvedExportOptions } from "./options.js";

// --- escaping ----------------------------------------------------------------

/**
 * Escape a user-derived string for LaTeX text mode: `\ % & _ # $ { } ~ ^` →
 * their kernel macros. A SINGLE regex pass — sequential replacements would
 * re-escape the braces the earlier replacements introduce (e.g. the `{}` of
 * `\textbackslash{}`). Every workspace-originating string in the output
 * passes through here; only deliberately-emitted LaTeX syntax and math
 * expressions stay raw.
 */
const LATEX_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "%": "\\%",
  "&": "\\&",
  "_": "\\_",
  "#": "\\#",
  "$": "\\$",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

export function escapeLatex(text: string): string {
  return text.replace(/[\\%&_#$~^{}]/g, (ch) => LATEX_ESCAPES[ch] ?? ch);
}

// --- preamble ------------------------------------------------------------------

function renderPreamble(options: ResolvedExportOptions): string {
  // §34.24 decision 5: LaTeX mirrors the layouts as article/two-column class
  // variants only — notes/essay are the same one-column article.
  const documentClass =
    options.layout === "academic"
      ? "\\documentclass[11pt,twocolumn]{article}"
      : "\\documentclass[11pt]{article}";
  return [
    documentClass,
    "\\usepackage[T1]{fontenc}",
    "\\usepackage[a4paper,margin=2.5cm]{geometry}",
    "\\usepackage{amsmath}",
    "\\usepackage{xcolor}",
    "\\definecolor{noteeshighlight}{HTML}{ECE4B8}",
    // [normalem] is load-bearing: bare ulem turns \emph into underline.
    "\\usepackage[normalem]{ulem}",
    "\\usepackage[hidelinks]{hyperref}",
    "",
    "\\setlength{\\parindent}{0pt}",
    "\\setlength{\\parskip}{6pt plus 2pt}",
  ].join("\n");
}

// --- spans → text ----------------------------------------------------------------

function renderMarkedText(text: string, marks: readonly string[]): string {
  // Code is the innermost wrap and stays escaped (unlike markdown's literal
  // code spans, \texttt content is parsed); the other marks keep the fixed
  // nesting order — innermost first: highlight, strike, italic, bold.
  let out: string = marks.includes("code") ? `\\texttt{${escapeLatex(text)}}` : escapeLatex(text);
  if (marks.includes("highlight")) out = `\\colorbox{noteeshighlight}{${out}}`;
  if (marks.includes("strike")) out = `\\sout{${out}}`;
  if (marks.includes("italic")) out = `\\emph{${out}}`;
  if (marks.includes("bold")) out = `\\textbf{${out}}`;
  return out;
}

function renderSpan(span: ExportSpan): string {
  switch (span.kind) {
    case "text":
      return renderMarkedText(span.text, span.marks);
    case "hardBreak":
      return "\\\\\n";
    case "mention":
      // Multi-file delivery (ctx.linkTarget resolved the target's file):
      // the [name](path) text convention — the .tex is single-file, so the
      // path is printed, not linked (see module doc comment).
      return span.linkPath !== undefined
        ? `[${escapeLatex(span.name)}](${escapeLatex(span.linkPath)})`
        : escapeLatex(span.name);
    case "classChip":
      return `#${escapeLatex(span.name)}`;
    case "typedLink": {
      const locator = span.locator === null ? "" : ` (${escapeLatex(span.locator)})`;
      return `\\textbf{${escapeLatex(span.verb)}} ${escapeLatex(span.text)}${locator}`;
    }
    case "externalLink":
      return `\\href{${escapeLatex(span.href)}}{${escapeLatex(span.text)}}`;
    case "math":
      // Authored LaTeX — verbatim inside $…$ (see module doc comment).
      return `$${span.expression}$`;
  }
}

function renderSpans(spans: readonly ExportSpan[]): string {
  return spans.map(renderSpan).join("");
}

// --- blocks → text -----------------------------------------------------------------

function renderBlock(block: ExportBlock): string {
  switch (block.kind) {
    case "paragraph":
      return renderSpans(block.spans);
    case "quote":
      return `\\begin{quote}\n${renderSpans(block.spans)}\n\\end{quote}`;
    case "asset": {
      // Single-file delivery carries no bytes: a boxed placeholder labeled
      // `Asset:` with the CAS id; a resolved bundle path (ctx.assetPath,
      // zip delivery) prints on a second line — \includegraphics is
      // deliberately not emitted (it would need the bytes, see module doc).
      const label = `Asset: \\texttt{${escapeLatex(block.assetId)}}`;
      const inner =
        block.assetPath !== undefined
          ? `${label}\\\\\n\\texttt{${escapeLatex(block.assetPath)}}`
          : label;
      return `\\fbox{\\parbox{0.9\\linewidth}{${inner}}}`;
    }
    case "embed":
      if (block.inlined !== null) {
        // The IR inliner is cycle-guarded, so the recursion is safe; the
        // inlined document's own outline stays markdown-bundle territory
        // (mirrors html.ts/docx.ts: blocks render, no nested outline).
        return renderBlocks(block.inlined.blocks);
      }
      return block.link !== undefined
        ? // Multi-file delivery: the [name](path) text convention.
          `[${escapeLatex(block.link.name)}](${escapeLatex(block.link.path)})`
        : `![[${block.nodeId}]]`;
    case "query":
      return `\\begin{verbatim}\n${JSON.stringify(block.queryAst, null, 2)}\n\\end{verbatim}`;
    case "whiteboard":
      return `\\begin{verbatim}\n${JSON.stringify(block.layout, null, 2)}\n\\end{verbatim}`;
  }
}

function renderBlocks(blocks: readonly ExportBlock[]): string {
  return blocks.map(renderBlock).join("\n\n");
}

// --- document chrome -----------------------------------------------------------------

/** Property value + per-value qualifiers, mirroring the markdown frontmatter
 * scalar and the HTML <dd> (`value (since 1962)`); null/undefined keep the
 * visible "null" placeholder when hideEmptyProperties is off. Escaping
 * happens at the call site. */
function renderPropertyText(property: ExportDocumentProperty): string {
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
  return base;
}

/**
 * The properties block: run-in `\paragraph*{schemaName} value` rows (one per
 * schema, multi-value schemas joined with `; `), plus the classNames row
 * when showTypeLabels is on. Returns "" when nothing survives the
 * hideEmptyProperties filter.
 */
function renderProperties(document: ExportDocument, options: ResolvedExportOptions): string {
  const rows: string[] = [];
  if (options.showTypeLabels && document.classNames.length > 0) {
    rows.push(`\\paragraph*{classNames} ${document.classNames.map(escapeLatex).join(", ")}`);
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
    rows.push(
      `\\paragraph*{${escapeLatex(schemaName)}} ${values
        .map((value) => escapeLatex(renderPropertyText(value)))
        .join("; ")}`,
    );
  }
  return rows.join("\n\n");
}

// --- outline --------------------------------------------------------------------------

/** Cut entries (cycle / explicit maxDepth) render the visible `![[uuid]]`
 * reference, never a silent drop; regular items carry the child's blocks
 * and a nested `itemize` for deeper levels (blank lines around nested
 * environments keep the output compilable). */
function renderOutline(children: readonly ExportDocumentChild[]): string {
  const items = children.map((child) => {
    if (child.cut !== undefined) {
      return `\\item ![[${child.id}]]`;
    }
    const parts: string[] = [];
    if (child.blocks.length > 0) parts.push(renderBlocks(child.blocks));
    if (child.children.length > 0) parts.push(renderOutline(child.children));
    return `\\item ${parts.join("\n\n")}`;
  });
  return `\\begin{itemize}\n${items.join("\n")}\n\\end{itemize}`;
}

// --- bibliography ------------------------------------------------------------------------

/** One exported node → its CSL record, or null when the CSL predicate does
 * not recognize it as a source (csl.ts `sourceClassOf` — the exact
 * detection the BibTeX/CSL path uses). Author display strings come from the
 * IR's resolved `authors` property rows (node-typed values already resolved
 * rename-free at build time). */
function cslOf(
  id: string,
  title: string,
  classIds: readonly string[],
  properties: readonly ExportDocumentProperty[],
): CslItem | null {
  if (sourceClassOf(classIds) === undefined) return null;
  const authors = properties
    .filter((property) => property.schemaId === SYSTEM_PROPERTY_UUIDS.authors)
    .map((property) => property.display);
  // A nodeId-shaped publicationDate resolves through the row's build-time
  // display string (the year node's label), rename-free.
  const pub = properties.find((property) => property.schemaId === SYSTEM_PROPERTY_UUIDS.publicationDate);
  const resolveName =
    pub !== undefined && typeof pub.value !== "string"
      ? (refId: string): string | undefined =>
          typeof (pub.value as { nodeId?: unknown }).nodeId === "string" &&
          (pub.value as { nodeId: string }).nodeId === refId
            ? pub.display
            : undefined
      : undefined;
  return nodeToCsl({ id, name: title.length > 0 ? title : null, classIds }, properties, authors, resolveName);
}

/**
 * Every source among the exported nodes, in encounter order: the document
 * root first, inlined embed documents depth-first in block order (their own
 * embeds and outline children recurse), then the outline children
 * depth-first. A node that appears more than once (embedded AND outlined,
 * say) contributes one entry — first occurrence wins.
 */
function collectSources(document: ExportDocument): CslItem[] {
  const seen = new Set<string>();
  const items: CslItem[] = [];
  const consider = (
    id: string,
    title: string,
    classIds: readonly string[],
    properties: readonly ExportDocumentProperty[],
  ): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const item = cslOf(id, title, classIds, properties);
    if (item !== null) items.push(item);
  };
  const visitChildren = (children: readonly ExportDocumentChild[]): void => {
    for (const child of children) {
      if (child.cut !== undefined) continue;
      consider(child.id, child.title, child.classIds, child.properties);
      for (const block of child.blocks) {
        if (block.kind === "embed" && block.inlined !== null) visit(block.inlined);
      }
      visitChildren(child.children);
    }
  };
  const visit = (doc: ExportDocument): void => {
    consider(doc.nodeId, doc.title, doc.classIds, doc.properties);
    for (const block of doc.blocks) {
      if (block.kind === "embed" && block.inlined !== null) visit(block.inlined);
    }
    visitChildren(doc.children);
  };
  visit(document);
  return items;
}

/** The rendered entry text: `Authors (Year). \emph{Title}.` composed from
 * the CSL record (csl.ts `formatAuthors` for the BibTeX-style name list);
 * container/publisher/DOI fields are not projected in v1. Missing parts are
 * omitted — a source without authors or year still compiles. */
function renderSourceText(item: CslItem): string {
  const authors =
    item.author !== undefined && item.author.length > 0 ? escapeLatex(formatAuthors(item.author)) : "";
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  const lead = [authors, year !== undefined ? `(${year})` : ""].filter((part) => part.length > 0).join(" ");
  const leadText = lead.length === 0 ? "" : lead.endsWith(".") ? lead : `${lead}.`;
  const title =
    item.title !== undefined && item.title.trim().length > 0
      ? ` \\emph{${escapeLatex(item.title.trim())}}.`
      : "";
  return `${leadText}${title}`;
}

/** One `thebibliography` environment with a `\bibitem` per source, keyed by
 * citekey (falling back to the node id, per `nodeToCsl`). Emitted only when
 * at least one source exists. */
function renderBibliography(items: readonly CslItem[]): string {
  const entries = items.map(
    (item) => `\\bibitem{${escapeLatex(item.id)}} ${renderSourceText(item)}`,
  );
  return `\\begin{thebibliography}{99}\n${entries.join("\n")}\n\\end{thebibliography}`;
}

// --- document ------------------------------------------------------------------------------

/**
 * Serialize a built {@link ExportDocument} to one complete, compilable
 * LaTeX document: class-variant preamble, the `\section*{title}` heading for
 * nodes with document chrome, the properties rows, the content blocks, the
 * nested-`itemize` outline when the IR carries children, and the
 * `thebibliography` environment when at least one exported node is a source.
 * Synchronous text render (the registry's text formats stay sync).
 */
export function renderExportDocumentToLatex(
  document: ExportDocument,
  options: ResolvedExportOptions,
): string {
  const body: string[] = [];
  // Document-chrome discipline mirrors markdown/html/docx: inline blocks
  // (parented, render bit unset) carry no visible title heading.
  if (document.rendersDocumentChrome) {
    const heading = document.title.length > 0 ? escapeLatex(document.title) : document.nodeId;
    body.push(`\\section*{${heading}}`);
  }
  const properties = renderProperties(document, options);
  if (properties.length > 0) body.push(properties);
  const blocks = renderBlocks(document.blocks);
  if (blocks.length > 0) body.push(blocks);
  if (document.children.length > 0) {
    body.push(`\\section*{Outline}\n\n${renderOutline(document.children)}`);
  }
  const sources = collectSources(document);
  if (sources.length > 0) {
    body.push(renderBibliography(sources));
  }
  return `${[renderPreamble(options), "", "\\begin{document}", "", body.join("\n\n"), "", "\\end{document}"].join("\n")}\n`;
}
