/**
 * Export options bag + per-format gating.
 *
 * One typed bag threads through `nodeToMarkdown` / `bundleMarkdown` and the
 * format-registry serializers; every option is optional at the surface and
 * resolved to concrete defaults by {@link resolveExportOptions}. The defaults
 * are the E2-hardened behavior: metacharacter escaping ON, full tree closure
 * (no depth cap), empty properties hidden — so existing two-argument callers
 * get the hardened engine without changes.
 *
 * Options added beyond the original bag (each is a deliberate extension):
 *
 *  - `maxDepth` — the retired silent `MAX_CHILD_DEPTH` cap returns as an
 *    EXPLICIT option; `null` (default) renders the whole tree, and a hit
 *    renders a visible `![[uuid]]` cut bullet, never a silent truncation.
 *  - `layout` — the Notes/Essay/Academic render themes as an engine
 *    option: `"notes"` (default) | `"essay"` | `"academic"`, gated to
 *    pdf/docx/html/latex. H1 projects it as the HTML body class +
 *    stylesheet variants; P1/D1/L1 theme the paged formats.
 *  - `whiteboardMode` — `"inline"` (single-file default: fenced ```json) vs
 *    `"sidecar"` (bundle/zip mode: sidecar JSON file + file link, the
 *    Tier-2 convention "whiteboards → sidecar JSON + file link").
 *  - `filenamePolicy` — bundle file naming: `"uuid"` (`<uuid>.md`, default —
 *    rename-free) vs `"slug"` (`<slugified-title>-<id8>.md`, id8 fallback
 *    for empty titles; the id8 suffix — a pure hash of the node id — keeps
 *    names unique for duplicate titles). The server zip reuses this policy.
 *
 * Workspace-zip enumeration (owner ruling 2026-10-04):
 * the server zip's page set is `Store.roots` + the main-children DFS MINUS
 * the system-seed pages (inbox — the scratchpad was withdrawn but
 * legacy workspaces still carry it) and the date chain
 * (year/month/day nodes — journal scaffolding, 5,657 files of noise on the
 * real workspace). This is an enumeration rule, not a serializer option —
 * serializers never see the excluded rows; links targeting them keep the
 * single-file `[[name]]`/`![[uuid]]` conventions.
 *
 * Gating: `includeOutline` — pdf/docx/html (+ markdown:
 * markdown is both a single-file and an outline format, so it supports the
 * option too); `pageFormat` — pdf only; `includeAssets` — the markdown
 * bundle/zip path only (zip is markdown-bundle delivery, not its own
 * registry format). The catalog below is the machine-readable form the
 * format registry and the later UI render from.
 */

/** Registry format ids — the export-redesign format set. */
export type ExportFormatId = "markdown" | "html" | "pdf" | "docx" | "latex";

/** Options accepted by every serializer entry point. All optional. */
export interface ExportOptions {
  /**
   * Embed projection: ON inlines the embed target's rendered content when
   * resolvable through `ExportContext.nodeOf`; OFF (default) keeps the
   * `![[uuid]]` reference. Unresolvable targets always fall back to `![[uuid]]`.
   */
  includeEmbedded?: boolean | undefined;
  /**
   * Child outline (the nested-bullets children section). Default ON for
   * markdown; the gating table's pdf/docx/html set is the minimum — markdown
   * is both a single-file and an outline format, so it supports the option
   * too (a deliberate extension, documented here).
   */
  includeOutline?: boolean | undefined;
  /**
   * Hide empty property values (null / undefined / "" / whitespace-only /
   * empty array) from the frontmatter. Default ON.
   */
  hideEmptyProperties?: boolean | undefined;
  /**
   * Show type labels: ON adds a `classNames:` frontmatter line with the
   * resolved display names of the node's classes (the IR also carries
   * `classNames` so non-markdown serializers can project their own label
   * scheme later). Default OFF.
   */
  showTypeLabels?: boolean | undefined;
  /** Page size for paged formats. pdf only. Default "a4". */
  pageFormat?: "a4" | "letter" | undefined;
  /**
   * Layout theme: "notes" (default — the app's look), "essay" (typeset serif
   * single column), "academic" (two-column). Gated to pdf/docx/html/latex;
   * html (H1) projects it as the body class + stylesheet variants, the paged
   * formats get full theming in P1/D1/L1.
   */
  layout?: "notes" | "essay" | "academic" | undefined;
  /**
   * Include asset bytes. markdown bundle/zip delivery only (task E5/E7); the
   * IR collects `assetRefs` regardless so the bundle walker has them.
   * Default OFF.
   */
  includeAssets?: boolean | undefined;
  /** Explicit child-depth cap; null/undefined = full closure (default). */
  maxDepth?: number | null | undefined;
  /** Whiteboard projection: inline fenced json (default) or sidecar file. */
  whiteboardMode?: "inline" | "sidecar" | undefined;
  /** Bundle file naming: uuid (default) or `<slug>-<id8>.md`. */
  filenamePolicy?: "uuid" | "slug" | undefined;
}

/** The bag with every default resolved. */
export interface ResolvedExportOptions {
  includeEmbedded: boolean;
  includeOutline: boolean;
  hideEmptyProperties: boolean;
  showTypeLabels: boolean;
  pageFormat: "a4" | "letter";
  layout: "notes" | "essay" | "academic";
  includeAssets: boolean;
  /** null = render the whole tree (full closure). */
  maxDepth: number | null;
  whiteboardMode: "inline" | "sidecar";
  filenamePolicy: "uuid" | "slug";
}

export function resolveExportOptions(options?: ExportOptions): ResolvedExportOptions {
  return {
    includeEmbedded: options?.includeEmbedded ?? false,
    includeOutline: options?.includeOutline ?? true,
    hideEmptyProperties: options?.hideEmptyProperties ?? true,
    showTypeLabels: options?.showTypeLabels ?? false,
    pageFormat: options?.pageFormat ?? "a4",
    layout: options?.layout ?? "notes",
    includeAssets: options?.includeAssets ?? false,
    maxDepth: options?.maxDepth ?? null,
    whiteboardMode: options?.whiteboardMode ?? "inline",
    filenamePolicy: options?.filenamePolicy ?? "uuid",
  };
}

// --- per-format option gating ------------------------------------------------

export type ExportOptionKind = "boolean" | "select" | "number";

export interface ExportOptionChoice {
  value: string;
  label: string;
}

/**
 * Machine-readable option spec for later UI rendering (the export modal
 * renders its options section from these). `appliesTo` is the gating set.
 */
export interface ExportOptionSpec {
  key: keyof ExportOptions;
  label: string;
  kind: ExportOptionKind;
  default: unknown;
  /** Formats whose serializers consume this option (the gating table). */
  appliesTo: readonly ExportFormatId[];
  choices?: readonly ExportOptionChoice[];
  /** Free-form UI note (delivery-mode caveats, empty-means-unbounded, …). */
  note?: string;
}

const ALL_FORMATS: readonly ExportFormatId[] = ["markdown", "html", "pdf", "docx", "latex"];
const OUTLINE_FORMATS: readonly ExportFormatId[] = ["markdown", "pdf", "docx", "html"];

/** The gated option catalog — single source for registry metadata + UI. */
export const EXPORT_OPTION_SPECS: readonly ExportOptionSpec[] = [
  {
    key: "includeEmbedded",
    label: "Expand embedded pages inline",
    kind: "boolean",
    default: false,
    appliesTo: ALL_FORMATS,
  },
  {
    key: "includeOutline",
    label: "Include child outline",
    kind: "boolean",
    default: true,
    appliesTo: OUTLINE_FORMATS,
    note: "Nested-bullets children section; markdown is both a single-file and an outline format.",
  },
  {
    key: "hideEmptyProperties",
    label: "Hide empty properties",
    kind: "boolean",
    default: true,
    appliesTo: ALL_FORMATS,
  },
  {
    key: "showTypeLabels",
    label: "Show classes",
    kind: "boolean",
    default: false,
    appliesTo: ALL_FORMATS,
    note: "Markdown renders a classNames: frontmatter line; chrome renderers (the PDF) draw the class pills with their colors — the row's right-hand column, like the app's list view.",
  },
  {
    key: "pageFormat",
    label: "Page size",
    kind: "select",
    default: "a4",
    appliesTo: ["pdf"],
    choices: [
      { value: "a4", label: "A4" },
      { value: "letter", label: "Letter" },
    ],
  },
  {
    key: "layout",
    label: "Layout",
    kind: "select",
    default: "notes",
    appliesTo: ["pdf", "docx", "html", "latex"],
    choices: [
      { value: "notes", label: "Notes" },
      { value: "essay", label: "Essay" },
      { value: "academic", label: "Academic" },
    ],
    note: "Render theme; HTML projects it as stylesheet variants, the paged formats theme it in P1/D1/L1.",
  },
  {
    key: "includeAssets",
    label: "Include asset files",
    kind: "boolean",
    default: false,
    appliesTo: ["markdown"],
    note: "Bundle/zip delivery; single-file markdown keeps CAS references.",
  },
  {
    key: "maxDepth",
    label: "Maximum outline depth",
    kind: "number",
    default: null,
    appliesTo: OUTLINE_FORMATS,
    note: "Empty = full closure; a hit renders a visible ![[uuid]] cut bullet, never a silent cut.",
  },
  {
    key: "whiteboardMode",
    label: "Whiteboard layout",
    kind: "select",
    default: "inline",
    appliesTo: ["markdown"],
    choices: [
      { value: "inline", label: "Inline JSON block (single file)" },
      { value: "sidecar", label: "Sidecar JSON file + link (bundle/zip)" },
    ],
  },
  {
    key: "filenamePolicy",
    label: "File naming",
    kind: "select",
    default: "uuid",
    appliesTo: ["markdown"],
    choices: [
      { value: "uuid", label: "UUID filenames (rename-free)" },
      { value: "slug", label: "<title-slug>-<id8>" },
    ],
  },
];

/** Option specs applicable to one format, in catalog order. */
export function optionSpecsFor(format: ExportFormatId): readonly ExportOptionSpec[] {
  return EXPORT_OPTION_SPECS.filter((spec) => spec.appliesTo.includes(format));
}
