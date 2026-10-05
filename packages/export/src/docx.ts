/**
 * ExportDocument IR → Word .docx projection (§34.24 task D1) — mirrors the
 * H1 HTML reference rendering's structure (html.ts): the same
 * document-chrome predicate gates the title heading, properties render as a
 * two-column table mirroring the HTML <dl>, the same per-value qualifier
 * convention (`value (since 1962)`), the same visible-cut discipline for
 * outline cycle/depth entries, and the same single-file placeholder
 * treatment for assets and unresolved embeds. The projection is pure and
 * IO-free like every serializer in this package: the `docx` library assembles
 * the OOXML package in-process (no fs, no network), and
 * {@link renderExportDocumentToDocx} returns the package bytes.
 *
 * Word-specific projection choices (docx is not a link-projection format):
 *
 *  - External links render as `text (href)` plain runs. A real docx Hyperlink
 *    needs a relationship id per target; v1 keeps the package relationship-
 *    free and stays readable as plain text.
 *  - Mentions/chips render as their resolved names (chips with the leading
 *    `#`); typed links render `verb text (locator)`; math renders the
 *    `$…$` expression — all plain text, no relationship ids.
 *  - The IR carries no asset bytes (single-file delivery), so an asset block
 *    is a bordered placeholder paragraph labeled `Asset:` with the CAS id,
 *    printing the bundle-relative path on a second line when ctx.assetPath
 *    resolved one (zip delivery).
 *  - Query/whiteboard blocks are Courier New paragraphs carrying the
 *    pretty-printed JSON, one line per run (`break: 1` line jumps).
 *
 * Layouts (minimal honor per §34.24): "notes" keeps the Word defaults
 * (Calibri body font, single-ish leading); "essay"/"academic" switch the
 * default document font to Georgia with looser leading via docDefaults, so
 * every style inheriting from Normal (including Title) follows. `pageFormat`
 * is pdf-gated and deliberately NOT consumed here — the section is A4
 * (Word's default page size) fixed via section properties.
 *
 * Token → docx mapping:
 *
 *  | Token/IR block | docx                                                        |
 *  |----------------|-------------------------------------------------------------|
 *  | text           | TextRun; marks → run properties: bold/italics/strike,       |
 *  |                |   highlight → HighlightColor.YELLOW, code → Courier New     |
 *  | hard_break     | TextRun({ break: 1 })                                       |
 *  | mention        | resolved name (plain text — no relationships in v1)         |
 *  | class_chip     | `#name`                                                     |
 *  | typed_link     | runs: verb (bold) + " " + text + " (locator)"               |
 *  | external_link  | runs: text + " (href)"                                      |
 *  | math           | `$expression$`                                              |
 *  | quote          | Paragraph style "Quote" (custom: italics + left indent)     |
 *  | asset_ref      | bordered placeholder paragraph, `Asset:` label + id [+ path]|
 *  | embed_ref      | inlined (includeEmbedded): the target's blocks recursively; |
 *  |                |   unresolved: `![[uuid]]` (link: `name (path)`)             |
 *  | query          | monospace paragraph, pretty-printed QueryAST JSON           |
 *  | whiteboard     | monospace paragraph, pretty layout JSON                     |
 *  | outline cut    | bullet paragraph with the `![[uuid]]` text (never silent)   |
 */

import {
  BorderStyle,
  Document,
  HeadingLevel,
  HighlightColor,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { IParagraphOptions, IRunOptions } from "docx";

import type {
  ExportBlock,
  ExportDocument,
  ExportDocumentChild,
  ExportPropertyValue,
  ExportSpan,
} from "./document.js";
import { isEmptyPropertyValue, qualifierDisplayOf, withoutLeadingTitle } from "./document.js";
import type { ResolvedExportOptions } from "./options.js";

// --- layout + page constants ---------------------------------------------------

/** Code/monospace font — Word's classic monospace face (safe cross-platform). */
const CODE_FONT = "Courier New";

/**
 * Layout theming via docDefaults (the minimal §34.24 honor): notes keeps the
 * Word template look (Calibri); essay/academic typeset serif with looser
 * leading. Line spacing is in twentieths of a point on the "auto" rule
 * (240 = single, 276 ≈ Word's default 1.15, 360 = 1.5).
 */
const LAYOUT_DEFAULT_FONT: Record<ResolvedExportOptions["layout"], string> = {
  notes: "Calibri",
  essay: "Georgia",
  academic: "Georgia",
};

const LAYOUT_LINE_SPACING: Record<ResolvedExportOptions["layout"], number> = {
  notes: 276,
  essay: 360,
  academic: 360,
};

/** A4 portrait in twips (Word's default page); margins are Word's 1" default. */
const A4_WIDTH_TWIPS = 11906;
const A4_HEIGHT_TWIPS = 16838;
const PAGE_MARGIN_TWIPS = 1440;

// --- spans → runs ---------------------------------------------------------------

/**
 * One IR span → a sequence of TextRuns (most spans are a single run; breaks
 * and composed spans emit more). All user-derived strings ride inside run
 * `text` — docx text nodes are plain character data, so there is no markup
 * breakout to escape against (unlike HTML's element/attribute contexts).
 */
function renderSpan(span: ExportSpan): TextRun[] {
  switch (span.kind) {
    case "text":
      return [new TextRun(markedRunOptions(span.text, span.marks))];
    case "hardBreak":
      // `break` prepends a line break to the (empty) run — a real <w:br/>.
      return [new TextRun({ break: 1, text: "" })];
    case "mention":
      // Resolved name as plain text (docx Hyperlink needs relationship ids —
      // deliberately not a link projection, see module doc comment).
      return [new TextRun(span.name)];
    case "classChip":
      return [new TextRun(`#${span.name}`)];
    case "typedLink": {
      const runs = [
        new TextRun({ text: span.verb, bold: true }),
        new TextRun({ text: ` ${span.text}` }),
      ];
      if (span.locator !== null) runs.push(new TextRun({ text: ` (${span.locator})` }));
      return runs;
    }
    case "externalLink":
      // v1 link convention: the text followed by the href in parentheses
      // (a real Hyperlink would need a relationship id per target).
      return [new TextRun({ text: `${span.text} (${span.href})` })];
    case "math":
      return [new TextRun({ text: `$${span.expression}$` })];
  }
}

/** Marks → run properties: bold/italics/strike are native; highlight maps to
 * the word highlight color set; code switches the font to Courier New. */
function markedRunOptions(text: string, marks: readonly string[]): ConstructorParameters<typeof TextRun>[0] {
  return {
    text,
    ...(marks.includes("bold") ? { bold: true } : {}),
    ...(marks.includes("italic") ? { italics: true } : {}),
    ...(marks.includes("strike") ? { strike: true } : {}),
    ...(marks.includes("highlight") ? { highlight: HighlightColor.YELLOW } : {}),
    ...(marks.includes("code") ? { font: CODE_FONT } : {}),
  };
}

function renderSpans(spans: readonly ExportSpan[]): TextRun[] {
  return spans.flatMap(renderSpan);
}

// --- blocks → paragraphs ----------------------------------------------------------

/** Pretty-printed JSON as monospace runs, one line per run so the package
 * carries real line breaks (`break: 1` line jumps, not run-together \n
 * text nodes). */
function jsonRuns(payload: unknown): TextRun[] {
  const lines = JSON.stringify(payload, null, 2).split("\n");
  return lines.map(
    (line, index) =>
      new TextRun({ text: line, font: CODE_FONT, size: 18, ...(index > 0 ? { break: 1 } : {}) }),
  );
}

function renderBlock(block: ExportBlock, bullet?: number): Paragraph[] {
  // Outline items render every paragraph at the item's bullet level (a child
  // page with several paragraphs reads as a list); body blocks pass no level.
  const atLevel = (options: IParagraphOptions): IParagraphOptions =>
    bullet === undefined ? options : { ...options, bullet: { level: bullet } };
  switch (block.kind) {
    case "paragraph":
      return [new Paragraph(atLevel({ children: renderSpans(block.spans) }))];
    case "quote":
      // "Quote" is a custom style registered below (italics + left indent) —
      // the docx library ships no Quote default.
      return [new Paragraph(atLevel({ style: "Quote", children: renderSpans(block.spans) }))];
    case "asset": {
      // Single-file delivery carries no bytes: a boxed placeholder labeled
      // `Asset:` with the CAS id; the bundle-relative path prints on a
      // second line when ctx.assetPath resolved the bytes (zip delivery).
      const children = [
        new TextRun({ text: "Asset: ", bold: true }),
        new TextRun({ text: block.assetId }),
      ];
      if (block.assetPath !== undefined) {
        children.push(new TextRun({ break: 1, text: block.assetPath, font: CODE_FONT }));
      }
      return [
        new Paragraph(
          atLevel({
            children,
            border: {
              top: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
              left: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
              right: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
            },
          }),
        ),
      ];
    }
    case "embed":
      if (block.inlined !== null) {
        // The IR inliner is cycle-guarded, so the recursion is safe; the
        // inlined document's own outline stays markdown-bundle territory
        // (mirrors html.ts: blocks render, no nested outline).
        return renderBlocks(block.inlined.blocks, bullet);
      }
      return [
        new Paragraph(
          atLevel({
            children:
              block.link !== undefined
                ? // Multi-file delivery: the target's name with its file in
                  // parentheses (same plain-text convention as external links).
                  [new TextRun({ text: `${block.link.name} (${block.link.path})` })]
                : [new TextRun(`![[${block.nodeId}]]`)],
          }),
        ),
      ];
    case "query":
      return [new Paragraph(atLevel({ children: jsonRuns(block.queryAst) }))];
    case "whiteboard":
      return [new Paragraph(atLevel({ children: jsonRuns(block.layout) }))];
  }
}

function renderBlocks(blocks: readonly ExportBlock[], bullet?: number): Paragraph[] {
  return blocks.flatMap((block) => renderBlock(block, bullet));
}

// --- document chrome --------------------------------------------------------------

/** Property value + per-value qualifiers, mirroring the markdown frontmatter
 * scalar and the HTML <dd> (`value (since 1962)`); null/undefined keep the
 * visible "null" placeholder when hideEmptyProperties is off. */
function renderPropertyText(property: ExportPropertyValue & { display: string }): string {
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
 * The properties table: one borderless row per schema — bold schemaName in
 * the narrow left column, one paragraph per value in the right (mirrors the
 * HTML <dl> grid) — plus the classNames row when showTypeLabels is on.
 * Returns null when nothing survives the hideEmptyProperties filter.
 */
function renderPropertiesTable(
  document: ExportDocument,
  options: ResolvedExportOptions,
): Table | null {
  interface PropertyRow {
    label: string;
    values: string[];
  }
  const rows: PropertyRow[] = [];
  if (options.showTypeLabels && document.classNames.length > 0) {
    rows.push({ label: "classNames", values: [...document.classNames] });
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
    rows.push({ label: schemaName, values: values.map(renderPropertyText) });
  }
  if (rows.length === 0) return null;
  // Borderless by default — the table is a labeled-grid layout for the
  // property rows (mirrors the HTML <dl>), not a ruled data table; the docx
  // library paints single borders on unspecified edges, so every edge is
  // turned off explicitly.
  const noBorder = { style: BorderStyle.NONE } as const;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [2400, 7200],
    borders: {
      top: noBorder,
      bottom: noBorder,
      left: noBorder,
      right: noBorder,
      insideHorizontal: noBorder,
      insideVertical: noBorder,
    },
    rows: rows.map(
      (row) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: 25, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: row.label, bold: true })] })],
            }),
            new TableCell({
              width: { size: 75, type: WidthType.PERCENTAGE },
              children: row.values.map((value) => new Paragraph({ children: [new TextRun(value)] })),
            }),
          ],
        }),
    ),
  });
}

// --- outline ------------------------------------------------------------------------

/** Cut entries (cycle / explicit maxDepth) render the visible `![[uuid]]`
 * reference, never a silent drop; regular items are bullet paragraphs whose
 * level follows the tree depth. */
function renderOutlineBlocks(
  children: readonly ExportDocumentChild[],
  level: number,
): Paragraph[] {
  const out: Paragraph[] = [];
  for (const child of children) {
    if (child.cut !== undefined) {
      out.push(new Paragraph({ bullet: { level }, children: [new TextRun(`![[${child.id}]]`)] }));
      continue;
    }
    out.push(...renderBlocks(child.blocks, level));
    out.push(...renderOutlineBlocks(child.children, level + 1));
  }
  return out;
}

// --- document -------------------------------------------------------------------------

/**
 * Serialize a built {@link ExportDocument} to a complete .docx package:
 * Title-heading + properties table for nodes with document chrome, the
 * content blocks (minus the leading title span when it rides in the Title
 * heading — the single-title rule), and — unless includeOutline left the
 * IR without children — the bullet-paragraph outline. Async because the
 * packer assembles and compresses the zip package off the call stack;
 * resolves to the package bytes (a .docx file is an OOXML zip).
 */
export async function renderExportDocumentToDocx(
  document: ExportDocument,
  options: ResolvedExportOptions,
): Promise<Uint8Array> {
  const children: (Paragraph | Table)[] = [];

  // Document-chrome discipline mirrors markdown/html: inline blocks carry
  // no visible title heading (the package's core title still labels it).
  if (document.rendersDocumentChrome) {
    const heading = document.title.length > 0 ? document.title : document.nodeId;
    children.push(
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(heading)] }),
    );
  }
  const properties = renderPropertiesTable(document, options);
  if (properties !== null) children.push(properties);
  children.push(...renderBlocks(withoutLeadingTitle(document)));
  if (document.children.length > 0) {
    children.push(...renderOutlineBlocks(document.children, 0));
  }

  const layout = options.layout;
  const docxDocument = new Document({
    title: document.title.length > 0 ? document.title : document.nodeId,
    creator: "Notees",
    styles: {
      default: {
        document: {
          run: { font: LAYOUT_DEFAULT_FONT[layout], size: 22 },
          paragraph: {
            spacing: { line: LAYOUT_LINE_SPACING[layout], lineRule: "auto" },
          },
        },
      },
      paragraphStyles: [
        {
          id: "Quote",
          name: "Quote",
          basedOn: "Normal",
          next: "Normal",
          run: { italics: true },
          paragraph: { indent: { left: 480 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: A4_WIDTH_TWIPS, height: A4_HEIGHT_TWIPS },
            margin: {
              top: PAGE_MARGIN_TWIPS,
              right: PAGE_MARGIN_TWIPS,
              bottom: PAGE_MARGIN_TWIPS,
              left: PAGE_MARGIN_TWIPS,
            },
          },
        },
        children,
      },
    ],
  });
  const buffer = await Packer.toBuffer(docxDocument);
  return new Uint8Array(buffer);
}
