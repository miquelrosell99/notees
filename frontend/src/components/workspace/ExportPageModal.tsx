/**
 * ExportPageModal - Modal for exporting a node
 *
 * Format-specific export experience:
 * - Markdown / HTML: readonly preview + copy-to-clipboard + download
 * - PDF: custom CSS textarea + download (saves HTML with CSS injected,
 *   ready for browser print-to-PDF)
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useExportSettingsStore } from '@/stores';
import { Modal } from '@/components/core/Modal';
import { copyToClipboard } from '@/utils/clipboardManager';
import { Button } from '@/components/core/Button';
import { SelectionButton } from '@/components/core/SelectionButton';
import { ButtonWithPanel } from '@/components/core/ButtonWithPanel';
import { BooleanToggle } from '@/components/core/BooleanToggle';
import api from '@/api/client';
import './ExportPageModal.css';

import type { ExportFormat, ExportLayout, ExportStyle, ExportProperties, ExportDensity, ExportNumbering, ExportMeasure, ExportDoctype, ExportLinkStyle } from '@/stores';

export interface ExportPageModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The node UUID to export */
  nodeUuid: string;
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportPageModal({ isOpen, onClose, nodeUuid }: ExportPageModalProps) {
  const {
    format, setFormat,
    layout, setLayout,
    style, setStyle,
    properties, setProperties,
    density, setDensity,
    numbering, setNumbering,
    measure, setMeasure,
    doctype, setDoctype,
    sectionBreak, setSectionBreak,
    formatting, setFormatting,
    showUuid, setShowUuid,
    linkStyle, setLinkStyle,
    cssOverrides, setCssOverrides,
  } = useExportSettingsStore();

  const [previewContent, setPreviewContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleFormatChange = useCallback((f: ExportFormat) => {
    setFormat(f);
  }, []);

  // Fetch text preview when format/layout changes (markdown / html only).
  // Stale content stays visible while the new fetch is in-flight to avoid flashing.
  useEffect(() => {
    if (!isOpen || format === 'pdf') {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .get(`/export/${nodeUuid}`, {
        params: { format, include_children: true, layout, formatting, style, properties, density, numbering, measure, doctype, section_break: sectionBreak, show_uuid: showUuid, link_style: linkStyle },
        responseType: 'text',
      })
      .then((response) => {
        if (!cancelled) setPreviewContent(response.data as string);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Failed to load preview');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, format, layout, formatting, style, properties, density, numbering, measure, doctype, sectionBreak, showUuid, linkStyle, nodeUuid]);

  // For the HTML tab, show only the <body> inner content (no doctype/head/style)
  const displayContent = useMemo(() => {
    if (format !== 'html' || !previewContent) return previewContent;
    const match = previewContent.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    return match ? match[1].trim() : previewContent;
  }, [format, previewContent]);

  const handleCopy = useCallback(() => {
    if (!previewContent) return;
    const text = format === 'html' ? displayContent : previewContent;
    copyToClipboard(text ?? '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [format, previewContent, displayContent]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      if (format === 'pdf') {
        // Fetch HTML, inject CSS overrides, then render to PDF on the server
        const htmlResponse = await api.get(`/export/${nodeUuid}`, {
          params: { format: 'html', include_children: true, layout, formatting, style, properties, density, numbering, measure, doctype, section_break: sectionBreak, show_uuid: showUuid, link_style: linkStyle },
          responseType: 'text',
        });
        let html = htmlResponse.data as string;
        if (cssOverrides.trim()) {
          const styleTag = `<style>\n${cssOverrides.trim()}\n</style>`;
          html = html.includes('</head>')
            ? html.replace('</head>', `${styleTag}\n</head>`)
            : styleTag + '\n' + html;
        }
        // POST the HTML back to get a real PDF
        const pdfResponse = await api.post(
          `/export/render-pdf`,
          { html },
          { responseType: 'blob' }
        );
        triggerBlobDownload(pdfResponse.data as Blob, 'export.pdf');
      } else {
        const response = await api.get(`/export/${nodeUuid}`, {
          params: { format, include_children: true, layout, formatting, style, properties, density, numbering, measure, doctype, section_break: sectionBreak, show_uuid: showUuid, link_style: linkStyle },
          responseType: 'blob',
        });
        const disposition = response.headers['content-disposition'] as string | undefined;
        let filename = `export.${format === 'markdown' ? 'md' : format}`;
        if (disposition) {
          const match = disposition.match(/filename="?([^"]+)"?/);
          if (match) filename = match[1];
        }
        triggerBlobDownload(response.data as Blob, filename);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }, [format, layout, formatting, style, properties, density, numbering, measure, doctype, sectionBreak, showUuid, linkStyle, nodeUuid, cssOverrides]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Export"
      size="lg"
      footer={
        <div className="export-modal__footer">
          <ButtonWithPanel
            icon={"mdi mdi-cog"}
            size="sm"
            panelPosition="top"
            panelAlignment="start"
            panelWidth={320}
            showCloseButton={false}
            panelClassName="export-modal__options-panel"
            usePortal={true}
          >
            <div className="visibility-panel-content">
              <div className="visibility-option">
                <SelectionButton
                  size="sm"
                  label="Layout"
                  description="Outline preserves hierarchy, flat lists all content"
                  labelPosition="left"
                  options={[
                    { value: 'outline', icon: "mdi mdi-file-tree", label: 'Outline' },
                    { value: 'flat', icon: "mdi mdi-file-document-outline", label: 'Flat' },
                  ]}
                  value={layout}
                  onChange={(v) => setLayout(v as ExportLayout)}
                />
              </div>
              {format !== 'markdown' && (
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Style"
                    description="Visual theme for the exported document"
                    labelPosition="left"
                    options={[
                      { value: 'minimal', icon: "mdi mdi-text-short", label: 'Minimal' },
                      { value: 'technical', icon: "mdi mdi-book-open-page-variant", label: 'Technical' },
                      { value: 'book', icon: "mdi mdi-book", label: 'Book' },
                    ]}
                    value={style}
                    onChange={(v) => setStyle(v as ExportStyle)}
                  />
                </div>
              )}
              {format !== 'markdown' && (
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Density"
                    description="Spacing between elements in the output"
                    labelPosition="left"
                    options={[
                      { value: 'comfortable', icon: "mdi mdi-view-headline", label: 'Comfortable' },
                      { value: 'compact', icon: "mdi mdi-view-compact", label: 'Compact' },
                    ]}
                    value={density}
                    onChange={(v) => setDensity(v as ExportDensity)}
                  />
                </div>
              )}
              {format !== 'markdown' && (
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Measure"
                    description="Page width and column layout"
                    labelPosition="left"
                    options={[
                      { value: 'full', icon: "mdi mdi-arrow-expand-horizontal", label: 'Full' },
                      { value: 'readable', icon: "mdi mdi-text", label: 'Readable' },
                      { value: 'book', icon: "mdi mdi-book", label: 'Book' },
                      { value: 'two-column', icon: "mdi mdi-view-column", label: '2-column' },
                    ]}
                    value={measure}
                    onChange={(v) => setMeasure(v as ExportMeasure)}
                  />
                </div>
              )}
              {format !== 'markdown' && (
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Numbering"
                    description="Add hierarchical numbers to headings"
                    labelPosition="left"
                    options={[
                      { value: 'none', icon: "mdi mdi-format-list-bulleted", label: 'None' },
                      { value: 'hierarchical', icon: "mdi mdi-format-list-numbered-rtl", label: 'Hierarchical' },
                      { value: 'legal', icon: "mdi mdi-format-list-numbered", label: 'Legal' },
                      { value: 'appendix', icon: "mdi mdi-format-letter-case-upper", label: 'Appendix' },
                    ]}
                    value={numbering}
                    onChange={(v) => setNumbering(v as ExportNumbering)}
                  />
                </div>
              )}
              {format !== 'markdown' && (
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Document type"
                    description="Semantic document behaviour: page breaks, spacing, TOC"
                    labelPosition="left"
                    options={[
                      { value: 'none', icon: "mdi mdi-minus", label: 'None' },
                      { value: 'article', icon: "mdi mdi-newspaper", label: 'Article' },
                      { value: 'report', icon: "mdi mdi-file-chart-outline", label: 'Report' },
                      { value: 'book', icon: "mdi mdi-book", label: 'Book' },
                      { value: 'legal', icon: "mdi mdi-scale-balance", label: 'Legal' },
                      { value: 'academic', icon: "mdi mdi-school", label: 'Academic' },
                    ]}
                    value={doctype}
                    onChange={(v) => setDoctype(v as ExportDoctype)}
                  />
                </div>
              )}
              {format !== 'markdown' && (
                <div className="visibility-option">
                  <BooleanToggle
                    size="sm"
                    label="Section page breaks"
                    description="Force h1/h2 headings to start on a new page"
                    labelPosition="left"
                    checked={sectionBreak}
                    onChange={(e) => setSectionBreak(e.target.checked)}
                  />
                </div>
              )}
              <div className="visibility-option">
                <SelectionButton
                  size="sm"
                  label="Formatting"
                  description="Apply rich text styles or export plain text"
                  labelPosition="left"
                  options={[
                    { value: 'true', icon: "mdi mdi-format-text", label: 'Formatted' },
                    { value: 'false', icon: "mdi mdi-code-braces", label: 'Plain' },
                  ]}
                  value={formatting ? 'true' : 'false'}
                  onChange={(v) => setFormatting(v === 'true')}
                />
              </div>
              <div className="visibility-option">
                <SelectionButton
                  size="sm"
                  label="Properties"
                  description="Which nodes to show properties for"
                  labelPosition="left"
                  options={[
                    { value: 'none', icon: "mdi mdi-tag-off", label: 'None' },
                    { value: 'main', icon: "mdi mdi-tag-outline", label: 'Main node' },
                    { value: 'all', icon: "mdi mdi-tag-multiple-outline", label: 'All nodes' },
                  ]}
                  value={properties}
                  onChange={(v) => setProperties(v as ExportProperties)}
                />
              </div>
              <div className="visibility-option">
                <BooleanToggle
                  size="sm"
                  label="Show UUID"
                  description="Include the node UUID as a property in the export"
                  labelPosition="left"
                  checked={showUuid}
                  onChange={(e) => setShowUuid(e.target.checked)}
                />
              </div>
              <div className="visibility-option">
                <SelectionButton
                  size="sm"
                  label="Links"
                  description="Show raw UUIDs in links or only the display text"
                  labelPosition="left"
                  options={[
                    { value: 'raw', icon: "mdi mdi-link-variant", label: 'Raw' },
                    { value: 'text', icon: "mdi mdi-link-off", label: 'Text only' },
                  ]}
                  value={linkStyle}
                  onChange={(v) => setLinkStyle(v as ExportLinkStyle)}
                />
              </div>
            </div>
          </ButtonWithPanel>
          <div className="export-modal__footer-actions">
            <Button variant="ghost" onClick={onClose} disabled={downloading}>
              Cancel
            </Button>
            {format !== 'pdf' && (
              <Button
                variant="ghost"
                icon={copied ? "mdi mdi-check" : "mdi mdi-content-copy"}
                onClick={handleCopy}
                disabled={loading || !previewContent || downloading}
              >
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            )}
            <Button
              variant="primary"
              icon={"mdi mdi-download"}
              onClick={handleDownload}
              disabled={downloading || (format !== 'pdf' && loading)}
            >
              {downloading ? 'Downloading…' : 'Download'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="export-modal__body">
        {/* Format tabs */}
        <div className="export-modal__tabs" role="tablist" aria-label="Export format">
          {(['markdown', 'html', 'pdf'] as ExportFormat[]).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={format === f}
              className={`export-modal__tab${
                format === f ? ' export-modal__tab--active' : ''
              }`}
              onClick={() => handleFormatChange(f)}
            >
              {f === 'markdown' ? 'Markdown' : f === 'html' ? 'HTML' : 'PDF'}
            </button>
          ))}
        </div>

        {/* Preview (markdown / html) */}
        {format !== 'pdf' && (
          <div className="export-modal__preview-wrap">
            {error && (
              <div className="export-modal__error">{error}</div>
            )}
            <textarea
              className={`export-modal__preview${loading ? ' export-modal__preview--loading' : ''}`}
              readOnly
              value={displayContent}
              spellCheck={false}
              aria-label={`${format} preview`}
            />
          </div>
        )}

        {/* PDF: CSS overrides */}
        {format === 'pdf' && (
          <div className="export-modal__pdf-wrap">
            <label
              className="export-modal__label"
              htmlFor="export-css-overrides"
            >
              Custom CSS overrides{' '}
              <span className="export-modal__label-hint">(optional)</span>
            </label>
            <textarea
              id="export-css-overrides"
              className="export-modal__css-textarea"
              value={cssOverrides}
              onChange={(e) => setCssOverrides(e.target.value)}
              placeholder={`body { font-family: Georgia, serif; }\n@media print { .sidebar { display: none; } }`}
              spellCheck={false}
              rows={8}
            />
            <p className="export-modal__pdf-hint">
              Optional CSS is injected before rendering to PDF.
            </p>
            {error && <div className="export-modal__error">{error}</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}

