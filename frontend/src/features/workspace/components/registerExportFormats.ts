/**
 * Export Format Registration
 *
 * Eagerly imports and registers all export formats.
 */

import { registerExportFormat } from './exportFormatRegistry';

registerExportFormat({
  format: 'markdown',
  label: 'Markdown',
  extension: 'md',
  mimeType: 'text/markdown',
  supportsPreview: true,
  hasHtmlOptions: false,
  supportsCssOverrides: false,
  icon: 'markdown',
});

registerExportFormat({
  format: 'html',
  label: 'HTML',
  extension: 'html',
  mimeType: 'text/html',
  supportsPreview: true,
  hasHtmlOptions: true,
  supportsCssOverrides: true,
  icon: 'language-html5',
});

registerExportFormat({
  format: 'pdf',
  label: 'PDF',
  extension: 'pdf',
  mimeType: 'application/pdf',
  supportsPreview: true,
  hasHtmlOptions: true,
  supportsCssOverrides: true,
  icon: 'file-pdf-box',
});

registerExportFormat({
  format: 'text',
  label: 'Text',
  extension: 'txt',
  mimeType: 'text/plain',
  supportsPreview: true,
  hasHtmlOptions: false,
  supportsCssOverrides: false,
  icon: 'text',
});

registerExportFormat({
  format: 'json',
  label: 'JSON',
  extension: 'json',
  mimeType: 'application/json',
  supportsPreview: true,
  hasHtmlOptions: false,
  supportsCssOverrides: false,
  icon: 'code-json',
});
