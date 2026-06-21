/**
 * Export Format Registry
 *
 * Declarative registry for export formats.
 * Each format self-registers its metadata, eliminating hardcoded
 * conditionals and switch statements in ExportPageModal.
 */

export interface ExportFormatDefinition {
  /** Format identifier */
  format: string;

  /** Human-readable label */
  label: string;

  /** File extension (without dot) */
  extension: string;

  /** MIME type for download */
  mimeType: string;

  /** Whether this format supports live preview */
  supportsPreview: boolean;

  /** Whether this format supports HTML-specific options (style, theme mode, etc.) */
  hasHtmlOptions: boolean;

  /** Whether this format supports CSS overrides */
  supportsCssOverrides: boolean;

  /** Icon name (without mdi- prefix) */
  icon: string;
}

const registry = new Map<string, ExportFormatDefinition>();

export function registerExportFormat(def: ExportFormatDefinition): void {
  if (registry.has(def.format)) {
    console.warn(`ExportFormat for "${def.format}" is being overwritten.`);
  }
  registry.set(def.format, def);
}

export function unregisterExportFormat(format: string): void {
  registry.delete(format);
}

export function getExportFormat(format: string): ExportFormatDefinition | undefined {
  return registry.get(format);
}

export function getRegisteredExportFormats(): ExportFormatDefinition[] {
  return Array.from(registry.values());
}

export function getExportFormatLabels(): { format: string; label: string; icon: string }[] {
  return Array.from(registry.values()).map((def) => ({
    format: def.format,
    label: def.label,
    icon: def.icon,
  }));
}

/** Check if a format has HTML-specific options */
export function formatHasHtmlOptions(format: string): boolean {
  return getExportFormat(format)?.hasHtmlOptions ?? false;
}

/** Check if a format supports preview */
export function formatSupportsPreview(format: string): boolean {
  return getExportFormat(format)?.supportsPreview ?? false;
}

/** Get file extension for a format */
export function getExportExtension(format: string): string {
  return getExportFormat(format)?.extension ?? format;
}
