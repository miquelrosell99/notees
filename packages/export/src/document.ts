/**
 * ExportDocument IR — the per-format intermediate representation
 * (one IR built per node subtree; per-format
 * serializers consume the IR).
 *
 * `buildExportDocument` resolves the Revision-11 node subtree against the
 * injected {@link ExportContext} ONCE — display names, the children tree
 * (cycle-guarded, depth-gated), embed inlining, class-name labels — so
 * serializers stay pure projections over a resolved model and never touch
 * resolution themselves. The IR is per node subtree: `children` carries the
 * nested outline, `assetRefs` the CAS ids a bundle walker needs for
 * include-assets, and embedded targets arrive as nested documents.
 *
 * Closure semantics (full-closure default): the children tree renders to
 * arbitrary depth by default; the only cuts are VISIBLE — a cycle renders as
 * a `cut: "cycle"` entry (the serializer emits `![[uuid]]`), an explicit
 * `maxDepth` hit as `cut: "depth"`. There is no silent truncation.
 */

import type { ContentAst, InlineToken } from "@notees/protocol";
import { deriveDisplayName, parseDateNodeId, dateNodeDisplayLabel } from "@notees/domain";

import type { ExportOptions, ResolvedExportOptions } from "./options.js";
import { resolveExportOptions } from "./options.js";

/** A property value as projected by the object API (SCHEMA.md property rows). */
export interface ExportPropertyValue {
  schemaId: string;
  schemaName: string;
  /** The schema's declared type — drives the per-type display branches. */
  schemaType?: string | undefined;
  /** The schema's select options (select/multi_select values resolve to labels). */
  schemaOptions?: ReadonlyArray<{ id: string; label: string }> | undefined;
  value: unknown;
  /** Per-value qualifiers (e.g. `{ since: 1962 }`) rendered `value (since 1962)`. */
  metadata?: Record<string, unknown> | undefined;
}

/**
 * One qualifier entry's display text (PC6 read-leniency): a legacy scalar
 * rides as-is; a date-node ref (the canonical startDate/endDate shape)
 * formats from the deterministic id — no node lookup, `YYYY-MM-DD` at day
 * precision (year/month refs format as `YYYY` / `YYYY-MM`); anything else
 * falls back to String().
 */
export function qualifierDisplayOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "nodeId" in value) {
    const id = (value as { nodeId: unknown }).nodeId;
    if (typeof id === "string") {
      const parsed = parseDateNodeId(id);
      if (parsed !== null) {
        const year = String(parsed.year).padStart(4, "0");
        if (parsed.precision === "year") return year;
        const month = String(parsed.month).padStart(2, "0");
        if (parsed.precision === "month") return `${year}-${month}`;
        return `${year}-${month}-${String(parsed.day).padStart(2, "0")}`;
      }
      return id;
    }
  }
  return String(value);
}

/**
 * The qualifier tail every serializer shares — ` (key display, …)` appended
 * to a property's display string (the `value (since 1962)` shape). Prefers
 * the IR's build-time `resolvedQualifiers` (node refs resolved rename-free
 * through ctx.nameOf — never a raw uuid, never `[object Object]`) and falls
 * back to the ctx-free {@link qualifierDisplayOf} for rows built outside
 * `buildExportDocument`. Returns "" when there are no qualifiers.
 */
export function qualifierTail(
  property: ExportPropertyValue & {
    resolvedQualifiers?: ReadonlyArray<{ key: string; display: string }> | undefined;
  },
): string {
  const resolved = property.resolvedQualifiers;
  const entries =
    resolved !== undefined
      ? resolved.map(({ key, display }) => `${key} ${display}`)
      : property.metadata !== undefined && Object.keys(property.metadata).length > 0
        ? Object.entries(property.metadata).map(([key, entry]) => `${key} ${qualifierDisplayOf(entry)}`)
        : [];
  return entries.length > 0 ? ` (${entries.join(", ")})` : "";
}

/**
 * The node shape the exporter needs — satisfied by the object-API full
 * object. Revision-11 render-state model: the two booleans replace the
 * retired node_type enumeration (store row shape, 0/1).
 */
export interface ExportNode {
  id: string;
  /** Class identity bit: 1 = class node (always a root). */
  isClass: 0 | 1;
  /** Render bit for parented non-class nodes: 1 = main-children zone +
   * document chrome; 0 = inline body + block chrome. */
  presentAsMain: 0 | 1;
  /** Tree placement; null = workspace root. */
  parentId: string | null;
  name: string | null;
  contentAst: ContentAst;
  classIds: string[];
  properties: ExportPropertyValue[];
  /** Wire node fields (the icon/color precedent): the page cover/banner
   * asset refs and the main page a node alias points at. Optional at the
   * interface so hand-built fixtures stay lean; the JSON archive projects
   * them as explicit nulls (unset). */
  coverAssetId?: string | null;
  bannerAssetId?: string | null;
  aliasedNodeId?: string | null;
}

/**
 * Injected resolution surface — keeps this package pure and IO-free.
 * `nameOf` resolves node/class/property-schema ids to their current display
 * name (rename-free: mentions render the target's CURRENT name, SCHEMA Fork 4).
 * `childrenOf` provides direct children for the outline tree. `nodeOf`
 * (optional) resolves any node by id — the embed-inlining option
 * (`includeEmbedded`) needs it; without it, embeds keep rendering as
 * `![[uuid]]` references.
 *
 * The two optional rewriting hooks serve multi-file delivery (the workspace
 * zip): `linkTarget` maps a mention/embed TARGET node id to the
 * file that node was exported to, and `assetPath` maps an `asset_ref`'s CAS
 * id to the bundle-relative path of its bytes. When a hook returns, the
 * markdown serializer emits a relative local link instead of the
 * single-file `[[name]]` / `![[uuid]]` / `![asset](<uuid>)` conventions;
 * when it misses (or is absent) the conventions stand. Typed-link tokens
 * carry no resolved target (record-don't-resolve), so there is nothing to
 * rewrite for them.
 *
 * The two optional chrome hooks serve the paged/chrome-emitting renderers:
 * `colorOf` resolves a CLASS id to its display color (a concrete CSS value —
 * the caller resolves preset tokens), and `iconOf` resolves a node id to
 * its icon token (an MDI name in the web's grammar — the caller normalizes).
 * Both stay optional so ctx-free callers (the CLI, tests) keep working.
 */
export interface ExportContext {
  nameOf(id: string): string | undefined;
  childrenOf?(id: string): ExportNode[] | undefined;
  nodeOf?(id: string): ExportNode | undefined;
  /** Mention/embed target id → the exported file carrying that node (zip/bundle). */
  linkTarget?(id: string): { path: string } | undefined;
  /** asset_ref CAS id → the bundle-relative path of the asset's bytes. */
  assetPath?(assetId: string): string | undefined;
  /** Class id → display color (concrete CSS value), for class pills. */
  colorOf?(classId: string): string | null | undefined;
  /** Node id → icon token (MDI name), for node-link chips. */
  iconOf?(nodeId: string): string | null | undefined;
}

// --- IR ----------------------------------------------------------------------

/** Inline-scale content, names resolved at build time. */
export type ExportSpan =
  | { kind: "text"; text: string; marks: readonly string[] }
  | { kind: "hardBreak" }
  | {
      kind: "mention";
      targetNodeId: string;
      name: string;
      /** The target's icon token (ctx.iconOf resolved it) — MDI name in the
       *  web grammar; renderers with an icon source draw it before the name
       *  (the list-view chip look). Absent/null → name-only chip. */
      icon?: string | null | undefined;
      /** Relative link into a multi-file export (ctx.linkTarget resolved it);
       *  when present the serializer emits `[name](path)` over `[[name]]`. */
      linkPath?: string | undefined;
    }
  | { kind: "classChip"; classId: string; name: string }
  | { kind: "typedLink"; verb: string; text: string; locator: string | null }
  | { kind: "externalLink"; text: string; href: string }
  | { kind: "math"; expression: string };

/**
 * Block-scale content model: the flat token stream folded into paragraphs
 * (inline accumulation flushed by block-scale tokens and quotes), plus the
 * structural tokens. An embed carries the inlined target document when
 * `includeEmbedded` resolved it (`inlined: null` → the serializer emits the
 * `![[uuid]]` reference).
 */
export type ExportBlock =
  | { kind: "paragraph"; spans: readonly ExportSpan[] }
  | { kind: "quote"; spans: readonly ExportSpan[] }
  | {
      kind: "asset";
      assetId: string;
      /** Bundle-relative path of the asset's bytes (ctx.assetPath resolved
       *  it); when present the serializer links the path over the raw uuid. */
      assetPath?: string | undefined;
    }
  | {
      kind: "embed";
      nodeId: string;
      inlined: ExportDocument | null;
      /** Relative link into a multi-file export for a reference the inliner
       *  did not expand (ctx.linkTarget resolved it); the serializer emits
       *  `[name](path)` over `![[uuid]]`. */
      link?: { name: string; path: string } | undefined;
    }
  | { kind: "query"; queryAst: unknown }
  | { kind: "whiteboard"; layout: Record<string, unknown> };

/** One outline level; `cut` marks a visible truncation (never silent). */
export interface ExportDocumentChild {
  id: string;
  /** The child's resolved display title (content-derived, "" when the
   * child has no content-derived name) — the bibliography (L1) uses it as
   * the CSL title, via `nodeToCsl`. */
  title: string;
  /** The child's main-zone bit (Revision-11 render state): true = the child
   * is a main node (a child PAGE — titled outline entry); false = an inline
   * body BLOCK (renders body-only, nested in its parent's content, no title
   * heading — the same main-node vs block-node distinction the chrome
   * predicate encodes for the root). Serializers that render a nested
   * outline split the zones on this bit (the PDF layout); zone-blind
   * bullet outlines ignore it. */
  presentAsMain: boolean;
  /** The child's class ids — serializers that need per-node identity
   * (L1's bibliography: which children are source-classed, via
   * csl.ts `sourceClassOf`) read them here. */
  classIds: readonly string[];
  /** The child's resolved class display names, parallel to classIds —
   *  chrome renderers draw the row's class pills with these. */
  classNames: readonly string[];
  /** The child's resolved class display colors, parallel to classIds
   *  (ctx.colorOf) — the pills ride these backgrounds. */
  classColors?: readonly (string | null)[] | undefined;
  /** The child's authored properties with display strings resolved at build
   * time (same projection as the root's `properties`) — the L1 bibliography
   * feeds them to `nodeToCsl`. */
  properties: readonly ExportDocumentProperty[];
  /** The child's own content, folded to blocks. */
  blocks: readonly ExportBlock[];
  children: readonly ExportDocumentChild[];
  /** "cycle" — already on the path (serializer renders `![[uuid]]`);
   * "depth" — an explicit maxDepth was hit (same visible rendering). */
  cut?: "cycle" | "depth" | undefined;
}

/** One node's subtree, resolved and ready for any serializer. */
export interface ExportDocument {
  nodeId: string;
  /** Resolved display title ("" when the node has no content-derived name). */
  title: string;
  /** Document-chrome predicate (Revision-11 third cascade branch): false for
   * parented non-class nodes with the render bit unset — inline blocks carry
   * no `# title` heading and no frontmatter name line. */
  rendersDocumentChrome: boolean;
  isClass: boolean;
  presentAsMain: boolean;
  parentId: string | null;
  /** The node's own content, folded to blocks. */
  blocks: readonly ExportBlock[];
  /** Authored property rows with their display strings resolved (node-typed
   * values become the target's current name). Empty-hiding is the
   * serializer's option, see hideEmptyProperties. */
  properties: readonly ExportDocumentProperty[];
  /** The node's class ids (frontmatter classIds line). */
  classIds: readonly string[];
  /** Resolved class display names, parallel to classIds. */
  classNames: readonly string[];
  /** Resolved class display colors (concrete CSS values via ctx.colorOf),
   *  parallel to classIds — chrome renderers draw the class pills with
   *  these; absent where the caller injects no color resolver. */
  classColors?: readonly (string | null)[] | undefined;
  /** Outline tree; empty when includeOutline is off or no resolver is injected. */
  children: readonly ExportDocumentChild[];
  /** Every asset_ref target in this subtree (the node's own stream, inlined
   * embed documents, and the child outline streams — deduped, in encounter
   * order) — the include-assets bundle walker starts here. */
  assetRefs: readonly string[];
}

/**
 * A property row with its display string resolved at build time — serializers
 * are ctx-free, so node-typed values (`{ nodeId }`) become the target's
 * current display name here (rename-free, SCHEMA Fork 4), everything else
 * follows the scalar projection (string/number/boolean/null/JSON).
 *
 * `displayEntries` carries the per-element labels behind `display` where the
 * value is a collection: one label per array element (select/multi_select
 * option ids resolved through the schema's options, node refs named) and the
 * two end labels `[start, end]` (null = open side) for date_range values —
 * the Markdown frontmatter's list/map branches consume these instead of
 * re-deriving them serializer-side.
 *
 * `resolvedQualifiers` carries the per-value metadata qualifiers (PC6
 * startDate/endDate and future keys) with node refs resolved to display
 * strings at build time — serializers render these instead of raw
 * `Object.entries` joins, so a date-node ref never leaks as a raw uuid (or
 * worse, `[object Object]`). Verbatim `metadata` stays on the row.
 */
export interface ExportDocumentProperty extends ExportPropertyValue {
  display: string;
  displayEntries?: Array<string | null> | undefined;
  resolvedQualifiers?: ReadonlyArray<{ key: string; display: string }> | undefined;
}

// --- build -------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Empty-value predicate behind hideEmptyProperties: null, undefined, ""
 * (and whitespace-only strings), and empty arrays are empty; every other
 * value (0, false, non-empty strings, objects, records) renders.
 */
export function isEmptyPropertyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Sidecar filename for a whiteboard layout: `<owner-id>.whiteboard.json` for
 * the first layout in a node's stream, `<owner-id>.<n>.whiteboard.json` for
 * subsequent ones. The markdown serializer (file link) and the bundle
 * emitter (sidecar file) both derive names from this helper, so they can
 * never disagree. `owner-id` is the id of the node whose content stream
 * carries the whiteboard (an inlined embed target keeps its own id).
 */
export function whiteboardSidecarPath(ownerId: string, index: number): string {
  return index === 0 ? `${ownerId}.whiteboard.json` : `${ownerId}.${index}.whiteboard.json`;
}

/** Names collapse to single-line inline-safe text (markdown inline contexts
 * cannot carry raw newlines). */
function normalizeInlineName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * Blocks-level single-title rule (title-is-content): the display name IS
 * the node's own text content, so a rendering that emits the title as a
 * heading must not render that same text again as the body's first line.
 * When the first content block is a paragraph opening with a text span
 * whose whitespace-folded text equals the title, that span rides in the
 * heading alone — it is dropped here, and the emptied paragraph drops with
 * it. Everything else passes through untouched. Shared by the document
 * root ({@link withoutLeadingTitle}) and the outline children (a child
 * page's title heading rides the same rule — the child body must not open
 * with the same text again).
 */
export function withoutLeadingTitleBlocks(
  title: string,
  blocks: readonly ExportBlock[],
): readonly ExportBlock[] {
  const normalized = normalizeInlineName(title);
  if (normalized.length === 0) return blocks;
  const [first, ...rest] = blocks;
  if (first === undefined || first.kind !== "paragraph") return blocks;
  const [span, ...remainingSpans] = first.spans;
  if (span === undefined || span.kind !== "text") return blocks;
  if (normalizeInlineName(span.text) !== normalized) return blocks;
  if (remainingSpans.length === 0) return rest;
  return [{ ...first, spans: remainingSpans }, ...rest];
}

/**
 * Single-title rule at the document root: applies {@link withoutLeadingTitleBlocks}
 * only when the document renders chrome (the heading exists); nodes without
 * chrome, and inlined embeds (their hosts render no heading), pass through.
 */
export function withoutLeadingTitle(document: ExportDocument): readonly ExportBlock[] {
  if (!document.rendersDocumentChrome) return document.blocks;
  return withoutLeadingTitleBlocks(document.title, document.blocks);
}

interface BuildState {
  /** Per-path cycle guard (the document root seeds its own id). */
  visited: ReadonlySet<string>;
}

export function buildExportDocument(
  node: ExportNode,
  ctx: ExportContext,
  options: ResolvedExportOptions,
  state?: BuildState,
  assetRefs?: string[],
): ExportDocument {
  const visited = state?.visited ?? new Set<string>([node.id]);
  const collected = assetRefs ?? [];
  const title = deriveDisplayName(node);
  const blocks = buildBlocks(node.contentAst, ctx, options, visited, collected);
  const children = options.includeOutline
    ? buildChildren(node.id, ctx, options, visited, 1, collected)
    : [];
  return {
    nodeId: node.id,
    title,
    rendersDocumentChrome: !(node.isClass === 0 && node.parentId !== null && node.presentAsMain === 0),
    isClass: node.isClass === 1,
    presentAsMain: node.presentAsMain === 1,
    parentId: node.parentId,
    blocks,
    properties: node.properties.map((property) => ({
      ...property,
      ...resolvePropertyDisplay(property, ctx),
    })),
    classIds: node.classIds,
    classNames: node.classIds.map((id) => normalizeInlineName(ctx.nameOf(id) ?? id)),
    ...(ctx.colorOf !== undefined
      ? { classColors: node.classIds.map((id) => ctx.colorOf!(id) ?? null) }
      : {}),
    children,
    assetRefs: collected,
  };
}

/**
 * Build the block model for a standalone token stream (the seam behind the
 * markdown renderer's `renderContent` and available to other serializers
 * that want to project a bare contentAst without a full node).
 */
export function buildExportBlocks(
  ast: ContentAst | null | undefined,
  ctx: ExportContext,
  options?: ExportOptions,
): ExportBlock[] {
  return buildBlocks(ast, ctx, resolveExportOptions(options), new Set<string>(), []);
}

/** Property value → display string (node-typed values resolve rename-free). */
function resolvePropertyDisplay(
  property: ExportPropertyValue,
  ctx: ExportContext,
): {
  display: string;
  displayEntries?: Array<string | null>;
  resolvedQualifiers?: Array<{ key: string; display: string }>;
} {
  return { ...resolvePropertyValueDisplay(property, ctx), ...resolveQualifiers(property, ctx) };
}

/**
 * Per-value metadata qualifiers (PC6 startDate/endDate and future keys)
 * resolved for display: a `{ nodeId }` ref or a legacy bare-uuid string
 * (v1-migrated data, same leniency as the value branches) resolves through
 * ctx.nameOf — settings-aware date formatting where the resolver is — with
 * the deterministic date-id label and finally the raw string as honest
 * fallbacks. Non-ref values render via String().
 */
function resolveQualifiers(
  property: ExportPropertyValue,
  ctx: ExportContext,
): { resolvedQualifiers?: Array<{ key: string; display: string }> } {
  if (property.metadata === undefined || Object.keys(property.metadata).length === 0) return {};
  const resolved = Object.entries(property.metadata).map(([key, entry]) => {
    const refId =
      isRecord(entry) && typeof entry.nodeId === "string"
        ? entry.nodeId
        : typeof entry === "string"
          ? entry
          : null;
    if (refId !== null) {
      const named = ctx.nameOf(refId);
      if (named !== undefined) return { key, display: normalizeInlineName(named) };
      const parsed = parseDateNodeId(refId);
      if (parsed !== null) return { key, display: dateNodeDisplayLabel(parsed, parsed.precision) };
      return { key, display: refId };
    }
    return { key, display: String(entry) };
  });
  return { resolvedQualifiers: resolved };
}

function resolvePropertyValueDisplay(
  property: ExportPropertyValue,
  ctx: ExportContext,
): { display: string; displayEntries?: Array<string | null> } {
  const value = property.value;
  // Node-typed read-leniency (SCHEMA.md PB2): v1-migrated data rides the
  // log as BARE uuid strings instead of canonical `{ nodeId }` refs. On a
  // node-typed schema (date/object/asset) a bare string resolves through
  // ctx.nameOf exactly like a canonical ref — the settings-aware web
  // resolver formats date nodes per the user's dateFormat — and falls back
  // to the raw string when the target is unknown (the existence-lenient
  // doctrine for legacy encodings). Scalar-typed schemas (text/url/email/
  // select/multi_select) never take this branch: their bare strings are
  // legitimately scalar.
  const NODE_TYPED_SCHEMAS = new Set(["date", "object", "asset"]);
  const nodeTyped =
    property.schemaType !== undefined && NODE_TYPED_SCHEMAS.has(property.schemaType);
  const nodeRefDisplay = (refId: string): string =>
    normalizeInlineName(ctx.nameOf(refId) ?? refId);
  const optionLabel = (entry: unknown): string | null => {
    if (typeof entry !== "string" || property.schemaOptions === undefined) return null;
    return property.schemaOptions.find((option) => option.id === entry)?.label ?? null;
  };
  const entryText = (entry: unknown): string => {
    const label = optionLabel(entry);
    if (label !== null) return label;
    if (typeof entry === "string") return nodeTyped ? nodeRefDisplay(entry) : entry;
    if (typeof entry === "number") return String(entry);
    if (typeof entry === "boolean") return entry ? "☑" : "☐";
    if (isRecord(entry) && typeof entry.nodeId === "string") {
      return nodeRefDisplay(entry.nodeId);
    }
    return JSON.stringify(entry) ?? "";
  };
  // date_range: { start, end } of date refs, either side open (PB2 shape).
  if (isRecord(value) && !("nodeId" in value) && ("start" in value || "end" in value)) {
    const ends: Array<string | null> = [value.start, value.end].map((end) => {
      const ref =
        isRecord(end) && typeof end.nodeId === "string" ? end.nodeId : typeof end === "string" ? end : null;
      return ref === null ? null : normalizeInlineName(ctx.nameOf(ref) ?? ref);
    });
    const startLabel = ends[0] ?? "…";
    const endLabel = ends[1] ?? "…";
    return { display: `${startLabel} → ${endLabel}`, displayEntries: ends };
  }
  // multi_select: an array of option ids (SCHEMA.md PC2 shape).
  if (Array.isArray(value)) {
    if (value.length === 0) return { display: "[]" };
    const entries = value.map(entryText);
    return { display: entries.join(", "), displayEntries: entries };
  }
  const label = optionLabel(value);
  if (label !== null) return { display: label };
  if (typeof value === "string") return { display: nodeTyped ? nodeRefDisplay(value) : value };
  if (typeof value === "number") return { display: String(value) };
  if (typeof value === "boolean") return { display: value ? "☑" : "☐" };
  if (value === null || value === undefined) return { display: "" };
  if (isRecord(value) && typeof value.nodeId === "string") {
    return { display: nodeRefDisplay(value.nodeId) };
  }
  return { display: JSON.stringify(value) ?? "" };
}

function buildBlocks(
  ast: ContentAst | null | undefined,
  ctx: ExportContext,
  options: ResolvedExportOptions,
  visited: ReadonlySet<string>,
  assetRefs: string[],
): ExportBlock[] {
  if (ast === null || ast === undefined) return [];
  const out: ExportBlock[] = [];
  let spans: ExportSpan[] = [];
  const flush = () => {
    if (spans.length > 0) {
      out.push({ kind: "paragraph", spans });
      spans = [];
    }
  };
  for (const token of ast) {
    if (token.type === "quote") {
      flush();
      out.push({ kind: "quote", spans: token.children.map((child) => buildSpan(child, ctx)) });
    } else if (token.type === "asset_ref") {
      flush();
      if (!assetRefs.includes(token.assetId)) assetRefs.push(token.assetId);
      out.push({ kind: "asset", assetId: token.assetId, assetPath: ctx.assetPath?.(token.assetId) });
    } else if (token.type === "embed_ref") {
      flush();
      const inlined = resolveEmbed(token.nodeId, ctx, options, visited, assetRefs);
      const link =
        inlined === null
          ? resolveEmbedLink(token.nodeId, ctx)
          : undefined;
      out.push({ kind: "embed", nodeId: token.nodeId, inlined, link });
    } else if (token.type === "query") {
      flush();
      out.push({ kind: "query", queryAst: token.queryAst });
    } else if (token.type === "whiteboard") {
      flush();
      out.push({ kind: "whiteboard", layout: token.layout });
    } else if (token.type === "code_block") {
      // Interim projection: the export IR has no code block kind
      // yet (a fenced kind + the five serializers ride the post-lockstep
      // export slice) — export the source as one inline-code span so no
      // prose is lost and the span stream stays well-formed.
      flush();
      out.push({
        kind: "paragraph",
        spans: [{ kind: "text", text: token.text, marks: ["code"] }],
      });
    } else if (token.type === "hr") {
      // The divider carries no prose — it flushes the paragraph
      // (a thematic-break export kind rides the same post-lockstep slice).
      flush();
    } else {
      spans.push(buildSpan(token as InlineToken, ctx));
    }
  }
  flush();
  return out;
}

/** includeEmbedded inlining: resolve via ctx.nodeOf, cycle-guarded per path. */
function resolveEmbed(
  nodeId: string,
  ctx: ExportContext,
  options: ResolvedExportOptions,
  visited: ReadonlySet<string>,
  assetRefs: string[],
): ExportDocument | null {
  if (!options.includeEmbedded || ctx.nodeOf === undefined || visited.has(nodeId)) return null;
  const target = ctx.nodeOf(nodeId);
  if (target === undefined) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(nodeId);
  return buildExportDocument(target, ctx, options, { visited: nextVisited }, assetRefs);
}

/**
 * Relative-link fallback for an embed the inliner did not expand: when
 * ctx.linkTarget knows the file the target node was exported to, the
 * serializer links there instead of the `![[uuid]]` reference. The display
 * name resolves rename-free via ctx.nameOf (raw id when unknown).
 */
function resolveEmbedLink(
  nodeId: string,
  ctx: ExportContext,
): { name: string; path: string } | undefined {
  const target = ctx.linkTarget?.(nodeId);
  if (target === undefined) return undefined;
  return { name: normalizeInlineName(ctx.nameOf(nodeId) ?? nodeId), path: target.path };
}

function buildSpan(token: InlineToken, ctx: ExportContext): ExportSpan {
  switch (token.type) {
    case "text":
      return { kind: "text", text: token.text, marks: token.marks ?? [] };
    case "hard_break":
      return { kind: "hardBreak" };
    case "mention": {
      const raw = token.displayText ?? ctx.nameOf(token.targetNodeId) ?? token.targetNodeId;
      const link = ctx.linkTarget?.(token.targetNodeId);
      return {
        kind: "mention",
        targetNodeId: token.targetNodeId,
        name: normalizeInlineName(raw),
        ...(ctx.iconOf !== undefined ? { icon: ctx.iconOf(token.targetNodeId) } : {}),
        ...(link !== undefined ? { linkPath: link.path } : {}),
      };
    }
    case "class_chip": {
      const raw = token.displayText ?? ctx.nameOf(token.classId) ?? token.classId;
      // Chip convention: whitespace folds to "-", leading # stripped (kept
      // from the original renderer — the serializer emits `#${name}` verbatim).
      return { kind: "classChip", classId: token.classId, name: normalizeInlineName(raw).replace(/\s+/g, "-").replace(/^#+/, "") };
    }
    case "typed_link": {
      const locator = token.metadata?.locator;
      return {
        kind: "typedLink",
        verb: normalizeInlineName(renderVerb(token.verb, ctx)),
        text: token.text,
        locator: locator === undefined ? null : normalizeInlineName(String(locator)),
      };
    }
    case "external_link":
      return { kind: "externalLink", text: token.text, href: token.href };
    case "math":
      return { kind: "math", expression: token.expression };
  }
}

function renderVerb(verb: unknown, ctx: ExportContext): string {
  if (typeof verb === "string") return verb;
  if (isRecord(verb) && typeof verb.propertySchemaId === "string") {
    return ctx.nameOf(verb.propertySchemaId) ?? verb.propertySchemaId;
  }
  return String(verb);
}

function buildChildren(
  id: string,
  ctx: ExportContext,
  options: ResolvedExportOptions,
  visited: ReadonlySet<string>,
  depth: number,
  assetRefs: string[],
): ExportDocumentChild[] {
  if (ctx.childrenOf === undefined) return [];
  const rows = ctx.childrenOf(id);
  if (rows === undefined || rows.length === 0) return [];
  const out: ExportDocumentChild[] = [];
  for (const child of rows) {
    if (visited.has(child.id)) {
      out.push({ id: child.id, title: "", presentAsMain: true, classIds: [], classNames: [], properties: [], blocks: [], children: [], cut: "cycle" });
      continue;
    }
    // Full closure by default; an explicit cap collapses deeper levels to a
    // visible cut entry (the root's children sit at depth 1).
    if (options.maxDepth !== null && depth > options.maxDepth) {
      out.push({ id: child.id, title: "", presentAsMain: true, classIds: [], classNames: [], properties: [], blocks: [], children: [], cut: "depth" });
      continue;
    }
    const childVisited = new Set(visited);
    childVisited.add(child.id);
    out.push({
      id: child.id,
      title: deriveDisplayName(child),
      presentAsMain: child.presentAsMain === 1,
      classIds: child.classIds,
      classNames: child.classIds.map((id) => normalizeInlineName(ctx.nameOf(id) ?? id)),
      ...(ctx.colorOf !== undefined
        ? { classColors: child.classIds.map((id) => ctx.colorOf!(id) ?? null) }
        : {}),
      properties: child.properties.map((property) => ({
        ...property,
        ...resolvePropertyDisplay(property, ctx),
      })),
      blocks: buildBlocks(child.contentAst, ctx, options, childVisited, assetRefs),
      children: buildChildren(child.id, ctx, options, childVisited, depth + 1, assetRefs),
    });
  }
  return out;
}

// --- whiteboard sidecar collection ----------------------------------------------

export interface ExportWhiteboardRef {
  /** The id of the node whose content stream carries the layout. */
  ownerId: string;
  layout: Record<string, unknown>;
}

/**
 * Every whiteboard block in a built document, in the order the markdown
 * serializer encounters them: the node's own blocks (recursing into inlined
 * embed documents), then the outline tree depth-first. `bundleMarkdown` uses
 * this to emit sidecar files whose names agree with the serializer's links —
 * per owner stream, the k-th occurrence gets `whiteboardSidecarPath(ownerId, k)`.
 */
export function listWhiteboardBlocks(document: ExportDocument): ExportWhiteboardRef[] {
  const out: ExportWhiteboardRef[] = [];
  const walkBlocks = (ownerId: string, blocks: readonly ExportBlock[]): void => {
    for (const block of blocks) {
      if (block.kind === "whiteboard") out.push({ ownerId, layout: block.layout });
      else if (block.kind === "embed" && block.inlined !== null) {
        walkBlocks(block.inlined.nodeId, block.inlined.blocks);
        walkChildren(block.inlined.children);
      }
    }
  };
  const walkChildren = (children: readonly ExportDocumentChild[]): void => {
    for (const child of children) {
      walkBlocks(child.id, child.blocks);
      walkChildren(child.children);
    }
  };
  walkBlocks(document.nodeId, document.blocks);
  walkChildren(document.children);
  return out;
}
