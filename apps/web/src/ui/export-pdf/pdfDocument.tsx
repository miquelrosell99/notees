/**
 * ExportDocument IR → react-pdf component tree.
 *
 * Pure projection over the resolved IR, mirroring the page view's structure
 * (H1 is the reference rendering): the title block (document chrome only —
 * a main node; a block-node root renders body-only, no title), the
 * properties table (booleans as drawn vector checkboxes, qualifiers via the
 * IR's resolved display — never a raw uuid), the content blocks minus the
 * leading title text (the single-title rule), the inline-block children
 * nested body-only at the body's end (block nodes carry no heading), and —
 * a separate end-of-document section — the recursive child-page list (the
 * main-zone children, each a titled entry, mirroring the page view's Child
 * pages section; no "Outline" heading, no divider). Layout themes from
 * theme.ts (Notes = app styling, Essay = single-column typeset, Academic =
 * two-column body + numbered headings). Assets render as real images when
 * the caller resolved a data URL through the client's cached asset read; a
 * miss renders the bordered placeholder box. Embeds arrive inlined from the
 * IR (includeEmbedded) or fall back to a reference line; query/whiteboard
 * blocks are verbatim JSON in a mono box; math is mono `$…$`. User-derived
 * strings are data here — react-pdf writes text runs verbatim (no markup
 * breakout is possible).
 *
 * The tree is plain React elements: rendering it with react-dom (the test
 * harness) yields the lowercase element DOM, and `pdf(<ExportPdfDocument/>)
 * .toBlob()` (renderPdf.ts) drives the real renderer in the browser.
 */

import { Document, Image, Page, StyleSheet, Svg, Text, View, Polyline, Rect } from "@react-pdf/renderer";
import type { ReactElement } from "react";

import type {
  ExportBlock,
  ExportDocument,
  ExportDocumentChild,
  ExportSpan,
  ResolvedExportOptions,
} from "@notees/export";
import { isEmptyPropertyValue, qualifierTail, withoutLeadingTitle, withoutLeadingTitleBlocks } from "@notees/export";

import "./fonts.js";
import { PDF_THEMES, type PdfLayout, type PdfTheme } from "./theme.js";

export interface ExportPdfDocumentProps {
  document: ExportDocument;
  options: ResolvedExportOptions;
  /** asset_ref CAS id → data URL (the client's cached image read); a miss renders the placeholder. */
  assetDataUrls?: ReadonlyMap<string, string>;
  /** Layout theme override — defaults to the options bag's layout. */
  layout?: PdfLayout;
}

/** The react-pdf pageSize tokens for the options bag's pageFormat. */
export function pdfPageSize(pageFormat: "a4" | "letter"): "A4" | "LETTER" {
  return pageFormat === "letter" ? "LETTER" : "A4";
}

type Styles = ReturnType<typeof buildStyles>;

function buildStyles(theme: PdfTheme) {
  return StyleSheet.create({
    page: {
      paddingTop: theme.page.paddingTop,
      paddingBottom: theme.page.paddingBottom,
      paddingLeft: theme.page.paddingLeft,
      paddingRight: theme.page.paddingRight,
      backgroundColor: theme.colors.paper,
      color: theme.colors.text,
      fontFamily: theme.fonts.body,
      fontSize: theme.type.bodySize,
      lineHeight: theme.type.bodyLineHeight,
    },
    title: {
      fontFamily: theme.fonts.heading,
      fontSize: theme.type.titleSize,
      fontWeight: theme.layout === "notes" ? 700 : 400,
      lineHeight: 1.25,
      marginBottom: 10,
    },
    properties: {
      borderTop: `1 solid ${theme.colors.rule}`,
      paddingTop: 8,
      marginBottom: 14,
    },
    propertyRow: {
      flexDirection: "row",
      marginBottom: 3,
    },
    propertyName: {
      width: "32%",
      fontSize: theme.type.bodySize - 2,
      color: theme.colors.muted,
      paddingTop: 1,
    },
    propertyValue: {
      width: "68%",
      fontSize: theme.type.bodySize - 1,
    },
    paragraph: { marginBottom: 8 },
    quote: {
      borderLeft: `2 solid ${theme.colors.rule}`,
      paddingLeft: 10,
      marginBottom: 8,
      color: theme.colors.muted,
    },
    pill: {
      backgroundColor: theme.colors.pill,
      color: theme.colors.pillText,
      borderRadius: 4,
      paddingLeft: 4,
      paddingRight: 4,
      fontSize: theme.type.bodySize - 1.5,
    },
    verb: { fontWeight: 700, color: theme.colors.accent },
    externalLink: { color: theme.colors.accent, textDecoration: "underline" },
    math: { fontFamily: theme.fonts.mono, fontSize: theme.type.bodySize - 1.5 },
    assetFigure: { marginBottom: 10 },
    assetImage: { maxWidth: "100%", maxHeight: 340, alignSelf: "center" },
    assetPlaceholder: {
      border: `1 solid ${theme.colors.rule}`,
      backgroundColor: theme.colors.surfaceVariant,
      paddingTop: 14,
      paddingBottom: 14,
      paddingLeft: 10,
      paddingRight: 10,
    },
    assetPlaceholderText: {
      textAlign: "center",
      fontSize: theme.type.bodySize - 2,
      color: theme.colors.muted,
    },
    embedBox: {
      borderLeft: `2 solid ${theme.colors.rule}`,
      paddingLeft: 10,
      marginBottom: 8,
    },
    embedRef: { color: theme.colors.muted, marginBottom: 8 },
    verbatimBox: {
      border: `1 solid ${theme.colors.rule}`,
      backgroundColor: theme.colors.surfaceVariant,
      paddingTop: 8,
      paddingBottom: 8,
      paddingLeft: 10,
      paddingRight: 10,
      marginBottom: 10,
    },
    verbatimText: {
      fontFamily: theme.fonts.mono,
      fontSize: theme.type.bodySize - 2.5,
      lineHeight: 1.45,
    },
    columns: { flexDirection: "row", marginBottom: 8 },
    column: { flex: 1 },
    nestedBlocks: { marginLeft: 14, marginBottom: 8 },
    nestedBlock: { marginBottom: 6 },
    outline: { paddingTop: 10, marginTop: 6 },
    outlineTitle: {
      fontFamily: theme.fonts.heading,
      fontSize: theme.type.bodySize + 1,
      fontWeight: 700,
      marginBottom: 3,
    },
    outlineNumber: { color: theme.colors.muted, fontWeight: 400 },
    propertyCheckbox: { flexDirection: "row", alignItems: "center" },
    cut: { fontFamily: theme.fonts.mono, fontSize: theme.type.bodySize - 2, color: theme.colors.muted },
  });
}

/** One inline span as a Text run; marks compose onto a single style. */
function PdfSpan({ span, styles, theme }: { span: ExportSpan; styles: Styles; theme: PdfTheme }): ReactElement {
  const style: {
    fontWeight?: number;
    fontStyle?: "italic";
    textDecoration?: "line-through";
    backgroundColor?: string;
    fontFamily?: string;
    fontSize?: number;
  } = {};
  if (span.kind === "text") {
    if (span.marks.includes("bold")) style.fontWeight = 700;
    if (span.marks.includes("italic")) style.fontStyle = "italic";
    if (span.marks.includes("strike")) style.textDecoration = "line-through";
    if (span.marks.includes("highlight")) style.backgroundColor = theme.colors.highlight;
    if (span.marks.includes("code")) {
      style.fontFamily = theme.fonts.mono;
      style.fontSize = theme.type.bodySize - 1.5;
      style.backgroundColor = theme.colors.surfaceVariant;
    }
    return <Text style={style}>{span.text}</Text>;
  }
  switch (span.kind) {
    case "hardBreak":
      return <Text>{"\n"}</Text>;
    case "mention":
      return <Text style={styles.pill}>{span.name}</Text>;
    case "classChip":
      return <Text style={styles.pill}>#{span.name}</Text>;
    case "typedLink":
      return (
        <Text>
          <Text style={styles.verb}>{span.verb}</Text> {span.text}
          {span.locator !== null ? ` (${span.locator})` : ""}
        </Text>
      );
    case "externalLink":
      return <Text style={styles.externalLink}>{span.text}</Text>;
    case "math":
      return (
        <Text style={styles.math}>
          ${span.expression}$
        </Text>
      );
  }
}

function PdfSpans({ spans, styles, theme }: { spans: readonly ExportSpan[]; styles: Styles; theme: PdfTheme }): ReactElement[] {
  return spans.map((span, index) => <PdfSpan key={index} span={span} styles={styles} theme={theme} />);
}

function PdfBlock({
  block,
  styles,
  theme,
  assetDataUrls,
}: {
  block: ExportBlock;
  styles: Styles;
  theme: PdfTheme;
  assetDataUrls: ReadonlyMap<string, string>;
}): ReactElement {
  switch (block.kind) {
    case "paragraph":
      return (
        <Text style={styles.paragraph}>
          <PdfSpans spans={block.spans} styles={styles} theme={theme} />
        </Text>
      );
    case "quote":
      return (
        <View style={styles.quote}>
          <Text>
            <PdfSpans spans={block.spans} styles={styles} theme={theme} />
          </Text>
        </View>
      );
    case "asset": {
      const dataUrl = assetDataUrls.get(block.assetId);
      if (dataUrl !== undefined) {
        return (
          <View style={styles.assetFigure}>
            <Image src={dataUrl} style={styles.assetImage} />
          </View>
        );
      }
      return (
        <View style={styles.assetFigure}>
          <View style={styles.assetPlaceholder}>
            <Text style={styles.assetPlaceholderText}>asset · {block.assetId.slice(0, 8)}</Text>
          </View>
        </View>
      );
    }
    case "embed":
      if (block.inlined !== null) {
        // The IR inliner is cycle-guarded, so the recursion is safe; the
        // inlined document's own outline stays markdown-bundle territory
        // (mirrors the html serializer: blocks render, no nested outline).
        return (
          <View style={styles.embedBox}>
            <PdfBlocks blocks={block.inlined.blocks} styles={styles} theme={theme} assetDataUrls={assetDataUrls} />
          </View>
        );
      }
      return (
        <Text style={styles.embedRef}>
          {block.link !== undefined ? `→ ${block.link.name} (${block.link.path})` : `![[${block.nodeId}]]`}
        </Text>
      );
    case "query":
      return (
        <View style={styles.verbatimBox}>
          <Text style={styles.verbatimText}>{JSON.stringify(block.queryAst, null, 2)}</Text>
        </View>
      );
    case "whiteboard":
      return (
        <View style={styles.verbatimBox}>
          <Text style={styles.verbatimText}>{JSON.stringify(block.layout, null, 2)}</Text>
        </View>
      );
  }
}

function PdfBlocks({
  blocks,
  styles,
  theme,
  assetDataUrls,
}: {
  blocks: readonly ExportBlock[];
  styles: Styles;
  theme: PdfTheme;
  assetDataUrls: ReadonlyMap<string, string>;
}): ReactElement[] {
  return blocks.map((block, index) => (
    <PdfBlock key={index} block={block} styles={styles} theme={theme} assetDataUrls={assetDataUrls} />
  ));
}

/** Academic splits the body across two flex Views (first half / second half). */
function splitBlocks(blocks: readonly ExportBlock[]): [readonly ExportBlock[], readonly ExportBlock[]] {
  const midpoint = Math.ceil(blocks.length / 2);
  return [blocks.slice(0, midpoint), blocks.slice(midpoint)];
}

/** A drawn checkbox (vector, no font-glyph dependency): an empty square, a
 *  polyline check when checked — the boolean property value's rendering. */
function PdfCheckbox({ checked, color }: { checked: boolean; color: string }): ReactElement {
  return (
    <Svg width={11} height={11} viewBox="0 0 12 12">
      <Rect x={0.75} y={0.75} width={10.5} height={10.5} stroke={color} strokeWidth={1} fill="none" />
      {checked ? (
        <Polyline points="2.5,6.2 5,8.7 9.8,3.4" stroke={color} strokeWidth={1.4} fill="none" />
      ) : null}
    </Svg>
  );
}

/** Document header: title (document chrome only) + the properties table. */
function PdfHeader({
  document,
  options,
  styles,
  theme,
}: {
  document: ExportDocument;
  options: ResolvedExportOptions;
  styles: Styles;
  theme: PdfTheme;
}): ReactElement | null {
  const rows: ReactElement[] = [];
  if (options.showTypeLabels && document.classNames.length > 0) {
    rows.push(
      <View key="classNames" style={styles.propertyRow}>
        <Text style={styles.propertyName}>classNames</Text>
        <Text style={styles.propertyValue}>{document.classNames.join(", ")}</Text>
      </View>,
    );
  }
  const visible = document.properties.filter(
    (property) => !options.hideEmptyProperties || !isEmptyPropertyValue(property.value),
  );
  for (const property of visible) {
    // Booleans render as the drawn checkbox (the owner's glyph ruling); the
    // qualifier tail rides the IR's build-time resolved qualifiers — a
    // date-node ref never leaks as a raw uuid.
    const isBoolean = property.schemaType === "boolean" && typeof property.value === "boolean";
    let display = property.display;
    if (display.length === 0 && (property.value === null || property.value === undefined)) display = "null";
    rows.push(
      <View key={`${property.schemaId}:${rows.length}`} style={styles.propertyRow}>
        <Text style={styles.propertyName}>{property.schemaName}</Text>
        {isBoolean ? (
          <View style={[styles.propertyValue, styles.propertyCheckbox]}>
            <PdfCheckbox checked={property.value === true} color={theme.colors.text} />
          </View>
        ) : (
          <Text style={styles.propertyValue}>{`${display}${qualifierTail(property)}`}</Text>
        )}
      </View>,
    );
  }
  if (!document.rendersDocumentChrome && rows.length === 0) return null;
  return (
    <View>
      {document.rendersDocumentChrome ? (
        <Text style={styles.title}>{document.title.length > 0 ? document.title : document.nodeId}</Text>
      ) : null}
      {rows.length > 0 ? <View style={styles.properties}>{rows}</View> : null}
    </View>
  );
}

/**
 * The end-list entries at one level of the child tree: the main children
 * (child pages), in document order, PLUS the main descendants hoisted out
 * of inline blocks — a page parented under a block is still a child page of
 * the exported subtree, so it belongs in the list at its position, never a
 * silent drop. Inline blocks themselves never appear here (they already
 * rendered nested in the body).
 */
function childPagesOf(children: readonly ExportDocumentChild[]): ExportDocumentChild[] {
  const out: ExportDocumentChild[] = [];
  const walk = (rows: readonly ExportDocumentChild[]): void => {
    for (const row of rows) {
      if (row.presentAsMain) out.push(row);
      else walk(row.children);
    }
  };
  walk(children);
  return out;
}

/**
 * The inline-block children of one node (presentAsMain false — block nodes),
 * nested in the parent's body the way the outliner renders them: body-only,
 * NO title heading (the Revision-11 rule: a block node carries no document
 * chrome), each with its own inline children recursed. Main nodes are
 * EXCLUDED at every level — they are child pages and belong to the end list
 * ({@link childPagesOf} hoists the ones parented under blocks); cut entries
 * render the visible `![[uuid]]` reference, never a silent drop. Returns
 * null when the node has no inline children.
 */
function PdfInlineChildren({
  children,
  styles,
  theme,
  assetDataUrls,
}: {
  children: readonly ExportDocumentChild[];
  styles: Styles;
  theme: PdfTheme;
  assetDataUrls: ReadonlyMap<string, string>;
}): ReactElement | null {
  const inline = children.filter((child) => !child.presentAsMain);
  if (inline.length === 0) return null;
  return (
    <View style={styles.nestedBlocks}>
      {inline.map((child) =>
        child.cut !== undefined ? (
          <Text key={child.id} style={styles.cut}>
            ![[{child.id}]]
          </Text>
        ) : (
          <View key={child.id} style={styles.nestedBlock}>
            <PdfBlocks blocks={child.blocks} styles={styles} theme={theme} assetDataUrls={assetDataUrls} />
            <PdfInlineChildren children={child.children} styles={styles} theme={theme} assetDataUrls={assetDataUrls} />
          </View>
        ),
      )}
    </View>
  );
}

function PdfOutlineChild({
  child,
  numbering,
  styles,
  theme,
  assetDataUrls,
}: {
  child: ExportDocumentChild;
  /** Academic numbering prefix (["1","2"] → this child is "1.2."). */
  numbering: readonly string[];
  styles: Styles;
  theme: PdfTheme;
  assetDataUrls: ReadonlyMap<string, string>;
}): ReactElement {
  if (child.cut !== undefined) {
    return (
      <Text style={styles.cut}>
        ![[{child.id}]]
      </Text>
    );
  }
  // Academic numbering: the path indices render "1.", "1.2.", "1.2.3.", …
  const number = theme.numberedHeadings && numbering.length > 0 ? `${numbering.join(".")}. ` : "";
  // A child page is a main node: its title rides the heading, and the
  // single-title rule strips that same text from the body's first line.
  // Its inline blocks nest body-only inside its content; its own child
  // pages ride the nested end list below.
  const childPages = childPagesOf(child.children);
  return (
    <View style={{ marginBottom: 6 }}>
      <Text style={styles.outlineTitle}>
        {number.length > 0 ? <Text style={styles.outlineNumber}>{number}</Text> : null}
        {child.title.length > 0 ? child.title : child.id}
      </Text>
      <PdfBlocks
        blocks={withoutLeadingTitleBlocks(child.title, child.blocks)}
        styles={styles}
        theme={theme}
        assetDataUrls={assetDataUrls}
      />
      <PdfInlineChildren children={child.children} styles={styles} theme={theme} assetDataUrls={assetDataUrls} />
      {childPages.length > 0 ? (
        <View style={{ marginTop: 2, marginLeft: 10 }}>
          {childPages.map((grandChild, index) => (
            <PdfOutlineChild
              key={grandChild.id}
              child={grandChild}
              numbering={[...numbering, String(index + 1)]}
              styles={styles}
              theme={theme}
              assetDataUrls={assetDataUrls}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The end-of-document child-page list: the main-zone children (child
 *  pages), recursive, each a titled entry — a separate section the way the
 *  page view's Child pages section lists them. Inline body blocks do NOT
 *  appear here: they already rendered nested in their parent's body — but
 *  their main descendants DO (hoisted by {@link childPagesOf}: a page
 *  parented under a block is still a child page of the subtree). No
 *  section heading, no divider — the entries stand on their titles. Null
 *  when the subtree has no child pages. */
function PdfOutline({
  children,
  styles,
  theme,
  assetDataUrls,
}: {
  children: readonly ExportDocumentChild[];
  styles: Styles;
  theme: PdfTheme;
  assetDataUrls: ReadonlyMap<string, string>;
}): ReactElement | null {
  const childPages = childPagesOf(children);
  if (childPages.length === 0) return null;
  return (
    <View style={styles.outline}>
      {childPages.map((child, index) => (
        <PdfOutlineChild
          key={child.id}
          child={child}
          numbering={theme.numberedHeadings ? [String(index + 1)] : []}
          styles={styles}
          theme={theme}
          assetDataUrls={assetDataUrls}
        />
      ))}
    </View>
  );
}

/**
 * The PDF document element: one flowing <Page> (react-pdf paginates
 * overflow automatically) in the layout theme, sized by the options bag's
 * pageFormat. Render with `pdf()` for bytes or with react-dom in tests.
 */
export function ExportPdfDocument({
  document,
  options,
  assetDataUrls,
  layout,
}: ExportPdfDocumentProps): ReactElement {
  const theme = PDF_THEMES[layout ?? options.layout];
  const styles = buildStyles(theme);
  const resolvedAssets = assetDataUrls ?? new Map<string, string>();
  const title = document.title.length > 0 ? document.title : document.nodeId;
  // The root's own body: the single-title rule strips the leading title text
  // when the document renders chrome (a main node); a block-node root
  // renders body-only (its title never surfaces as a heading). The root's
  // inline-block children ride nested at the body's end; child pages ride
  // the end-of-document list below.
  const bodyBlocks = withoutLeadingTitle(document);
  const [leftColumn, rightColumn] = theme.twoColumnBody ? splitBlocks(bodyBlocks) : [bodyBlocks, []];
  const inlineChildren = <PdfInlineChildren children={document.children} styles={styles} theme={theme} assetDataUrls={resolvedAssets} />;
  return (
    <Document title={title} author="Notees">
      <Page size={pdfPageSize(options.pageFormat)} style={styles.page}>
        <PdfHeader document={document} options={options} styles={styles} theme={theme} />
        {theme.twoColumnBody ? (
          <View style={styles.columns}>
            <View style={[styles.column, { paddingRight: theme.columnGap / 2 }]}>
              <PdfBlocks blocks={leftColumn} styles={styles} theme={theme} assetDataUrls={resolvedAssets} />
            </View>
            <View style={[styles.column, { paddingLeft: theme.columnGap / 2 }]}>
              <PdfBlocks blocks={rightColumn} styles={styles} theme={theme} assetDataUrls={resolvedAssets} />
            </View>
          </View>
        ) : (
          <>
            <PdfBlocks blocks={bodyBlocks} styles={styles} theme={theme} assetDataUrls={resolvedAssets} />
            {inlineChildren}
          </>
        )}
        {theme.twoColumnBody ? inlineChildren : null}
        <PdfOutline children={document.children} styles={styles} theme={theme} assetDataUrls={resolvedAssets} />
      </Page>
    </Document>
  );
}
