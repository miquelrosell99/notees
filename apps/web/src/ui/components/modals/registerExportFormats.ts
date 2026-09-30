/**
 * Export Format Registration
 *
 * Eagerly imports and registers all export formats.
 *
 * The export engine built on @notees/export produces Markdown; the other
 * formats are registered so the modal can list them, but producing them
 * requires the server-side export service and is reported honestly in the
 * UI instead of silently no-oping.
 */

import { registerExportFormat } from "./exportFormatRegistry.js";

registerExportFormat({
  format: "markdown",
  label: "Markdown",
  extension: "md",
  mimeType: "text/markdown",
  supportsPreview: true,
  hasHtmlOptions: false,
  supportsCssOverrides: false,
  icon: "markdown",
});

registerExportFormat({
  format: "html",
  label: "HTML",
  extension: "html",
  mimeType: "text/html",
  supportsPreview: true,
  hasHtmlOptions: true,
  supportsCssOverrides: true,
  icon: "language-html5",
});

registerExportFormat({
  format: "pdf",
  label: "PDF",
  extension: "pdf",
  mimeType: "application/pdf",
  supportsPreview: true,
  hasHtmlOptions: true,
  supportsCssOverrides: true,
  icon: "file-pdf-box",
});

registerExportFormat({
  format: "text",
  label: "Text",
  extension: "txt",
  mimeType: "text/plain",
  supportsPreview: true,
  hasHtmlOptions: false,
  supportsCssOverrides: false,
  icon: "text",
});

registerExportFormat({
  format: "json",
  label: "JSON",
  extension: "json",
  mimeType: "application/json",
  supportsPreview: true,
  hasHtmlOptions: false,
  supportsCssOverrides: false,
  icon: "code-json",
});
