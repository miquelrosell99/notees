/**
 * Format registry — the package-side catalog of export formats (§34.24 E1).
 * Every serializer consumes the {@link ExportDocument} IR; this module maps
 * format ids to labels, availability (with honest reasons), the per-format
 * option specs (from the gated catalog in options.ts — the task-E3 modal
 * renders its options section from these), and the serializer itself.
 *
 * Markdown and HTML are implemented. pdf/docx/latex are registered
 * skeletons with `availability: "unavailable"` and the work-record task that
 * will land them (P1/D1/L1) — the modal lists them disabled instead of
 * stub-message tabs, and their serializer throws loud rather than no-oping.
 * The web-side registry (task E3) delegates to this one.
 */

import type { ExportDocument } from "./document.js";
import { renderExportDocumentToHtml } from "./html.js";
import { renderExportDocumentToMarkdown } from "./markdown.js";
import type { ExportFormatId, ExportOptions, ExportOptionSpec } from "./options.js";
import { optionSpecsFor, resolveExportOptions } from "./options.js";

/** "available" | "unavailable" with a user-presentable reason. */
export type ExportFormatAvailability =
  | { status: "available" }
  | { status: "unavailable"; reason: string };

export interface ExportFormatDefinition {
  id: ExportFormatId;
  label: string;
  /** File extensions this format produces (bundle naming, save dialogs). */
  extensions: readonly string[];
  availability: ExportFormatAvailability;
  /** The option specs this format's serializer consumes (gated catalog subset). */
  options: readonly ExportOptionSpec[];
  /**
   * IR → text. Markdown and HTML render; the registered skeletons
   * (pdf/docx/latex) throw with their landing task — calling them is a
   * programmer error until they land.
   */
  serialize(document: ExportDocument, options?: ExportOptions): string;
}

function notImplemented(id: ExportFormatId, task: string): ExportFormatDefinition["serialize"] {
  return () => {
    throw new Error(
      `${id} export is registered but not implemented — it lands in ${task} of the export-redesign work record (§34.24).`,
    );
  };
}

export const EXPORT_FORMATS: readonly ExportFormatDefinition[] = [
  {
    id: "markdown",
    label: "Markdown",
    extensions: ["md"],
    availability: { status: "available" },
    options: optionSpecsFor("markdown"),
    serialize: (document, options) =>
      renderExportDocumentToMarkdown(document, resolveExportOptions(options)),
  },
  {
    id: "html",
    label: "HTML",
    extensions: ["html"],
    availability: { status: "available" },
    options: optionSpecsFor("html"),
    serialize: (document, options) =>
      renderExportDocumentToHtml(document, resolveExportOptions(options)),
  },
  {
    id: "pdf",
    label: "PDF",
    extensions: ["pdf"],
    availability: {
      status: "unavailable",
      reason:
        "PDF export lands in task P1 (Phase 2): client-side rendering with Notes/Essay/Academic layouts and the A4/Letter page option.",
    },
    options: optionSpecsFor("pdf"),
    serialize: notImplemented("pdf", "task P1"),
  },
  {
    id: "docx",
    label: "Word",
    extensions: ["docx"],
    availability: {
      status: "unavailable",
      reason: "Word (.docx) export lands in task D1 (Phase 3): a docx-lib serializer over the ExportDocument IR.",
    },
    options: optionSpecsFor("docx"),
    serialize: notImplemented("docx", "task D1"),
  },
  {
    id: "latex",
    label: "LaTeX",
    extensions: ["tex"],
    availability: {
      status: "unavailable",
      reason:
        "LaTeX export lands in task L1 (Phase 3): an escaping-correct template serializer with bibliography emission from source-class nodes.",
    },
    options: optionSpecsFor("latex"),
    serialize: notImplemented("latex", "task L1"),
  },
];

/** Look up a format definition by id. */
export function getExportFormat(id: ExportFormatId): ExportFormatDefinition | undefined {
  return EXPORT_FORMATS.find((format) => format.id === id);
}

/** The formats a caller may export today. */
export function availableExportFormats(): readonly ExportFormatDefinition[] {
  return EXPORT_FORMATS.filter((format) => format.availability.status === "available");
}
