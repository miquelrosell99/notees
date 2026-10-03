/**
 * Web-side export-format registry (§34.24 E3).
 *
 * Delegates to the package-side catalog in @notees/export (task E1) and adds
 * only web delivery metadata: MIME type, file extension, card icon, and the
 * subset of each format's option specs the export modal renders as checkbox
 * rows. Unavailable formats stay listed as disabled cards carrying the
 * package registry's reason — never stub-message tabs. Adding a format is
 * adding a package-side definition; the delivery table below is the only
 * web-side touchpoint.
 */

import {
  EXPORT_FORMATS,
  type ExportFormatAvailability,
  type ExportFormatDefinition,
  type ExportFormatId,
  type ExportOptions,
} from "@notees/export";

/**
 * The modal's own subtree option: which child pages join the export. It is
 * web-side delivery state (the engine receives it per call), not part of the
 * package's ExportOptions bag, so it rides the markdown definition here.
 */
export const INCLUDE_CHILD_PAGES_KEY = "includeChildPages";

/**
 * Option keys the modal renders as checkbox rows — the boolean engine
 * options only. E7 surfaces `includeAssets` (the markdown bundle/zip
 * delivery toggle); the remaining delivery-policy options (filenamePolicy,
 * whiteboardMode, maxDepth) stay engine-side defaults and never surface.
 */
const UI_OPTION_KEYS: readonly (keyof ExportOptions)[] = [
  "includeEmbedded",
  "includeOutline",
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
  id: ExportFormatId;
  label: string;
  /** Card icon (MDI name without the mdi- prefix). */
  icon: string;
  /** Delegated from the package registry — unavailable carries its reason. */
  availability: ExportFormatAvailability;
  /** MIME type for the downloaded file. */
  mimeType: string;
  /** File extension (no dot). */
  extension: string;
  /** Checkbox options the modal renders for this format, in display order. */
  options: readonly WebExportOptionSpec[];
}

/** Web delivery metadata per format id — the only web-side addition. */
const WEB_DELIVERY: Record<ExportFormatId, { mimeType: string; extension: string; icon: string }> = {
  markdown: { mimeType: "text/markdown", extension: "md", icon: "language-markdown-outline" },
  html: { mimeType: "text/html", extension: "html", icon: "language-html5" },
  pdf: { mimeType: "application/pdf", extension: "pdf", icon: "file-pdf-box" },
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
    availability: definition.availability,
    mimeType: delivery.mimeType,
    extension: delivery.extension,
    options,
  };
}

/** All registered formats, in package-catalog order (markdown first). */
export const WEB_EXPORT_FORMATS: readonly WebExportFormatDefinition[] = EXPORT_FORMATS.map(toWebDefinition);

export function getRegisteredExportFormats(): readonly WebExportFormatDefinition[] {
  return WEB_EXPORT_FORMATS;
}

export function getExportFormat(id: ExportFormatId): WebExportFormatDefinition | undefined {
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
