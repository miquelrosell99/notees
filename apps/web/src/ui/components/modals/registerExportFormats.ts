/**
 * Web-side export-format registry.
 *
 * Delegates to the package-side catalog in @notees/export and adds
 * only web delivery metadata: MIME type, file extension, card icon, the
 * delivery mode (`"file"` inline vs `"client-pdf"` for the lazily imported
 * PDF engine), and the subset of each format's option specs the export
 * modal renders as checkbox rows. Unavailable formats stay listed as
 * disabled cards carrying the package registry's reason — never stub-message
 * tabs. The availability overrides: pdf, which the web client renders
 * client-side even though the pure package serializer stays a
 * throwing skeleton (a pure package cannot pull react-pdf in); and the
 * JSON archive, a NODE-SET format that rides the modal like the IR
 * formats but deliberately stays out of the package's IR-based
 * EXPORT_FORMATS registry (its input is the verbatim node slice, not the
 * resolved ExportDocument — the bundleMarkdown/csv.ts precedent). Select-
 * type specs (layout/pageFormat) are exposed through {@link webSelectOption}
 * for the modal's dedicated cards/toggle. Adding an IR format is adding a
 * package-side definition; the delivery table below plus the explicit
 * json row are the only web-side touchpoints.
 */

import {
  EXPORT_FORMATS,
  optionSpecsFor,
  type ExportFormatAvailability,
  type ExportFormatDefinition,
  type ExportFormatId,
  type ExportOptionChoice,
  type ExportOptions,
} from "@notees/export";

/**
 * The modal's own subtree option: which child pages join the export. It is
 * web-side delivery state (the engine receives it per call), not part of the
 * package's ExportOptions bag, so it rides the markdown + json definitions
 * here.
 */
export const INCLUDE_CHILD_PAGES_KEY = "includeChildPages";

/** Web format ids — the package IR formats + the JSON archive card. */
export type WebExportFormatId = ExportFormatId | "json";

/**
 * Option keys the modal renders as checkbox rows — the boolean engine
 * options only. E7 surfaces `includeAssets` (the markdown bundle/zip
 * delivery toggle); the remaining delivery-policy options (filenamePolicy,
 * whiteboardMode, maxDepth) stay engine-side defaults and never surface.
 * `includeOutline` deliberately does NOT surface (owner 2026-10-09): the
 * child outline is unconditional — child blocks ride recursively in every
 * export and main nodes are child pages (files/end-list), so a toggle that
 * hides the content's own children makes no sense.
 */
const UI_OPTION_KEYS: readonly (keyof ExportOptions)[] = [
  "includeEmbedded",
  "hideEmptyProperties",
  "showTypeLabels",
  "includeAssets",
];

export interface WebExportOptionSpec {
  /** Engine bag key, or the modal-own {@link INCLUDE_CHILD_PAGES_KEY}. */
  key: keyof ExportOptions | typeof INCLUDE_CHILD_PAGES_KEY;
  label: string;
  defaultValue: boolean;
}

export interface WebExportFormatDefinition {
  id: WebExportFormatId;
  label: string;
  /** Card icon (MDI name without the mdi- prefix). */
  icon: string;
  /**
   * Delegated from the package registry — unavailable carries its reason.
   * The pdf entry is the one deliberate exception: the PACKAGE serializer
   * stays a throwing skeleton (a pure package cannot pull react-pdf in),
   * while the web client renders PDF client-side (task P1), so the web
   * registry marks it available with `delivery: "client-pdf"`.
   */
  availability: ExportFormatAvailability;
  /** MIME type for the downloaded file. */
  mimeType: string;
  /** File extension (no dot). */
  extension: string;
  /** How the bytes are produced: the local engine inline, or the lazily
   *  imported client-side PDF engine. */
  delivery: "file" | "client-pdf";
  /** Checkbox options the modal renders for this format, in display order. */
  options: readonly WebExportOptionSpec[];
}

/** Web delivery metadata per format id — the only web-side addition. */
const WEB_DELIVERY: Record<
  ExportFormatId,
  { mimeType: string; extension: string; icon: string; delivery?: "client-pdf" }
> = {
  markdown: { mimeType: "text/markdown", extension: "md", icon: "language-markdown-outline" },
  html: { mimeType: "text/html", extension: "html", icon: "language-html5" },
  pdf: { mimeType: "application/pdf", extension: "pdf", icon: "file-pdf-box", delivery: "client-pdf" },
  docx: {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
    icon: "file-word-outline",
  },
  latex: { mimeType: "application/x-latex", extension: "tex", icon: "code-tags" },
};

function toWebDefinition(definition: ExportFormatDefinition): WebExportFormatDefinition {
  const delivery = WEB_DELIVERY[definition.id];
  const options: WebExportOptionSpec[] = [];
  for (const spec of definition.options) {
    if (spec.kind !== "boolean" || !UI_OPTION_KEYS.includes(spec.key)) continue;
    options.push({ key: spec.key, label: spec.label, defaultValue: spec.default as boolean });
  }
  if (definition.id === "markdown") {
    options.push({ key: INCLUDE_CHILD_PAGES_KEY, label: "Include child pages", defaultValue: true });
  }
  return {
    id: definition.id,
    label: definition.label,
    icon: delivery.icon,
    availability:
      definition.id === "pdf" && delivery.delivery === "client-pdf"
        ? { status: "available" }
        : definition.availability,
    mimeType: delivery.mimeType,
    extension: delivery.extension,
    delivery: delivery.delivery ?? "file",
    options,
  };
}

/**
 * The JSON archive row — a node-set format outside the package's
 * IR registry, so its card is assembled web-side from the package's
 * archive constants. The only modal option that reaches the archive engine
 * is the subtree toggle (verbatim payloads ignore the display-options bag).
 */
function jsonArchiveWebDefinition(): WebExportFormatDefinition {
  return {
    id: "json",
    label: "JSON",
    icon: "code-json",
    availability: { status: "available" },
    mimeType: "application/json",
    extension: "json",
    delivery: "file",
    options: [{ key: INCLUDE_CHILD_PAGES_KEY, label: "Include child pages", defaultValue: true }],
  };
}

/** All registered formats, in package-catalog order (markdown first). */
export const WEB_EXPORT_FORMATS: readonly WebExportFormatDefinition[] = [
  ...EXPORT_FORMATS.map(toWebDefinition),
  jsonArchiveWebDefinition(),
];

export function getRegisteredExportFormats(): readonly WebExportFormatDefinition[] {
  return WEB_EXPORT_FORMATS;
}

export function getExportFormat(id: WebExportFormatId): WebExportFormatDefinition | undefined {
  return WEB_EXPORT_FORMATS.find((format) => format.id === id);
}

/** The formats the local engine can produce today. */
export function availableExportFormats(): readonly WebExportFormatDefinition[] {
  return WEB_EXPORT_FORMATS.filter((format) => format.availability.status === "available");
}

/** Checkbox-row defaults for a format, keyed by option key. */
export function defaultOptionValues(definition: WebExportFormatDefinition): Record<string, boolean> {
  const values: Record<string, boolean> = {};
  for (const spec of definition.options) values[spec.key] = spec.defaultValue;
  return values;
}

/**
 * A select-type option spec from the package catalog (layout / pageFormat)
 * — the P1 modal renders these as layout cards and the page-size
 * SelectionButton instead of checkbox rows. Undefined when the format does
 * not gate the key.
 */
export function webSelectOption(
  format: ExportFormatId,
  key: "layout" | "pageFormat",
): { choices: readonly ExportOptionChoice[]; defaultValue: string } | undefined {
  const spec = optionSpecsFor(format).find((candidate) => candidate.key === key && candidate.kind === "select");
  if (spec === undefined || spec.choices === undefined) return undefined;
  return { choices: spec.choices, defaultValue: String(spec.default) };
}
