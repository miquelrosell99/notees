/**
 * ExportPageModal - Modal for exporting one or more nodes
 *
 * Improvements:
 * - Live HTML preview for all formats (including PDF)
 * - Quick presets: Casual, Technical, Book
 * - Node name shown in title
 * - Batch export support (multiple node UUIDs)
 * - Dark mode toggle
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useCopiedState } from '@/hooks/useCopiedState';
import { useExportSettingsStore } from '@/stores';
import { Modal } from '@/components/ui/Modal';
import { copyToClipboard } from '@/utils/clipboardManager';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { ButtonWithPanel } from '@/components/ui/ButtonWithPanel';
import { BooleanToggle } from '@/components/ui/BooleanToggle';
import { Icon } from '@/components/ui/Icon';
import api from '@/api/client';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { downloadBlob } from '@/utils/download';
import QRCode from 'qrcode';
import { getExportFormat, formatHasHtmlOptions, getExportExtension, getRegisteredExportFormats } from './exportFormatRegistry';
import './registerExportFormats';
import './ExportPageModal.css';

import type { ExportFormat, ExportLayout, ExportStyle, ExportProperties, ExportDensity, ExportNumbering, ExportMeasure, ExportDoctype, ExportLinkStyle, ExportThemeMode } from '@/stores/exportSettingsStore';

export interface ExportPageModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Single node UUID (legacy) */
  nodeUuid?: string;
  /** Multiple node UUIDs for batch export */
  nodeUuids?: string[];
  /** Optional node name for the modal title */
  nodeName?: string;
  /** Optional node names for batch export */
  nodeNames?: string[];
}

export function ExportPageModal({ isOpen, onClose, nodeUuid, nodeUuids, nodeName }: ExportPageModalProps) {
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
    themeMode, setThemeMode,
    coverPage, setCoverPage,
    applyPreset,
  } = useExportSettingsStore();

  const [previewContent, setPreviewContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, triggerCopy] = useCopiedState();
  const [downloading, setDownloading] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrGenerating, setQrGenerating] = useState(false);
  const [htmlViewMode, setHtmlViewMode] = useState<'preview' | 'source'>('preview');

  const effectiveNodeUuids = useMemo(() => {
    if (nodeUuids && nodeUuids.length > 0) return nodeUuids;
    if (nodeUuid) return [nodeUuid];
    return [];
  }, [nodeUuid, nodeUuids]);

  const isBatch = effectiveNodeUuids.length > 1;

  const handleFormatChange = useCallback((f: ExportFormat) => {
    setFormat(f);
  }, [setFormat]);

  // Fetch preview HTML whenever settings change (all formats share the same preview).
  useEffect(() => {
    if (!isOpen || effectiveNodeUuids.length === 0) {
      return;
    }

    let cancelled = false;
    setLoading(true);
      setError(null);;

    const params: Record<string, unknown> = {
      format: formatHasHtmlOptions(format) ? 'html' : format,
      include_children: true,
      layout,
      formatting,
      style,
      properties,
      density,
      numbering,
      measure,
      doctype,
      section_break: sectionBreak,
      show_uuid: showUuid,
      link_style: linkStyle,
      theme_mode: themeMode,
      cover_page: coverPage,
    };

    const request = isBatch
      ? api.post('/export', { node_ids: effectiveNodeUuids, ...params }, { responseType: 'text' })
      : api.get(`/export/${effectiveNodeUuids[0]}`, { params, responseType: 'text' });

    request
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
  }, [isOpen, format, layout, formatting, style, properties, density, numbering, measure, doctype, sectionBreak, showUuid, linkStyle, themeMode, coverPage, effectiveNodeUuids, isBatch]);

  // For Markdown/Text/JSON tabs, show plain-text body content.
  // For HTML/PDF tab, show the raw HTML or inject CSS overrides.
  const displayContent = useMemo(() => {
    if (!previewContent) return '';
    if (!formatHasHtmlOptions(format)) {
      return previewContent;
    }
    if (cssOverrides.trim()) {
      const styleTag = `<style>\n${cssOverrides.trim()}\n</style>`;
      if (previewContent.includes('</head>')) {
        return previewContent.replace('</head>', `${styleTag}\n</head>`);
      }
    }
    return previewContent;
  }, [format, previewContent, cssOverrides]);

  const handleCopy = useCallback(() => {
    const text = displayContent || previewContent;
    if (!text) return;
    copyToClipboard(text).then(() => {
      triggerCopy();
    });
  }, [displayContent, previewContent, triggerCopy]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      const baseParams: Record<string, unknown> = {
        format,
        include_children: true,
        layout,
        formatting,
        style,
        properties,
        density,
        numbering,
        measure,
        doctype,
        section_break: sectionBreak,
        show_uuid: showUuid,
        link_style: linkStyle,
        theme_mode: themeMode,
        cover_page: coverPage,
      };

      if (getExportFormat(format)?.format === 'pdf') {
        const htmlParams = { ...baseParams, format: 'html' };
        let html: string;
        if (isBatch) {
          const htmlResponse = await api.post('/export', { node_ids: effectiveNodeUuids, ...htmlParams }, { responseType: 'text' });
          html = htmlResponse.data as string;
        } else {
          const htmlResponse = await api.get(`/export/${effectiveNodeUuids[0]}`, { params: htmlParams, responseType: 'text' });
          html = htmlResponse.data as string;
        }
        if (cssOverrides.trim()) {
          const styleTag = `<style>\n${cssOverrides.trim()}\n</style>`;
          html = html.includes('</head>')
            ? html.replace('</head>', `${styleTag}\n</head>`)
            : styleTag + '\n' + html;
        }
        const pdfResponse = await api.post(
          `/export/render-pdf`,
          { html },
          { responseType: 'blob' }
        );
        downloadBlob(pdfResponse.data as Blob, 'export.pdf');
      } else {
        let response;
        if (isBatch) {
          response = await api.post('/export', { node_ids: effectiveNodeUuids, ...baseParams }, { responseType: 'blob' });
        } else {
          response = await api.get(`/export/${effectiveNodeUuids[0]}`, { params: baseParams, responseType: 'blob' });
        }
        const disposition = response.headers['content-disposition'] ?? undefined;
        let filename = `export.${getExportExtension(format)}`;
        if (disposition) {
          const match = disposition.match(/filename="?([^"]+)"?/);
          if (match) filename = match[1];
        }
        downloadBlob(response.data as Blob, filename);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }, [format, layout, formatting, style, properties, density, numbering, measure, doctype, sectionBreak, showUuid, linkStyle, themeMode, coverPage, effectiveNodeUuids, isBatch, cssOverrides]);

  const handleGenerateQr = useCallback(async () => {
    const text = displayContent || previewContent;
    if (!text) return;
    setQrGenerating(true);
    setQrError(null);
    try {
      const dataUrl = await QRCode.toDataURL(text, {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });
      setQrDataUrl(dataUrl);
      setQrModalOpen(true);
    } catch (e: unknown) {
      setQrError(e instanceof Error ? e.message : 'Failed to generate QR code');
      setQrModalOpen(true);
    } finally {
      setQrGenerating(false);
    }
  }, [displayContent, previewContent]);

  const title = useMemo(() => {
    if (isBatch) {
      const count = effectiveNodeUuids.length;
      return `Export ${count} nodes`;
    }
    const plainName = nodeName ? nodeNameToText(nodeName) : '';
    return plainName ? `Export: ${plainName}` : 'Export';
  }, [isBatch, effectiveNodeUuids.length, nodeName]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <div className="export-modal__footer">
          <ButtonWithPanel
            icon={"mdi mdi-cog"}
            size="sm"
            panelPosition="top"
            panelAlignment="start"
            panelWidth={340}
            showCloseButton={false}
            panelClassName="export-modal__options-panel"
            usePortal={true}
          >
            <div className="visibility-panel-content">
              {/* Presets */}
              <div className="visibility-option">
                <div className="export-presets">
                  <span className="export-presets__label">Quick preset</span>
                  <div className="export-presets__row">
                    <button
                      type="button"
                      className="export-preset-btn"
                      onClick={() => applyPreset('casual')}
                      title="Casual note (Obsidian-like)"
                    >
                      <Icon path="mdi-note-text-outline" className="export-preset-btn__icon" />
                      <span className="export-preset-btn__text">Casual</span>
                    </button>
                    <button
                      type="button"
                      className="export-preset-btn"
                      onClick={() => applyPreset('editorial')}
                      title="Editorial prose (serif, elegant)"
                    >
                      <Icon path="mdi-feather" className="export-preset-btn__icon" />
                      <span className="export-preset-btn__text">Editorial</span>
                    </button>
                    <button
                      type="button"
                      className="export-preset-btn"
                      onClick={() => applyPreset('technical')}
                      title="Technical document (LaTeX-like)"
                    >
                      <Icon path="mdi-file-document-outline" className="export-preset-btn__icon" />
                      <span className="export-preset-btn__text">Technical</span>
                    </button>
                    <button
                      type="button"
                      className="export-preset-btn"
                      onClick={() => applyPreset('book')}
                      title="Long-form book"
                    >
                      <Icon path="mdi-book-open-variant" className="export-preset-btn__icon" />
                      <span className="export-preset-btn__text">Book</span>
                    </button>
                  </div>
                </div>
              </div>

              {formatHasHtmlOptions(format) && (
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Theme mode"
                    description="Light or dark background for the export"
                    labelPosition="left"
                    options={[
                      { value: 'light', icon: "mdi mdi-white-balance-sunny", label: 'Light' },
                      { value: 'dark', icon: "mdi mdi-weather-night", label: 'Dark' },
                    ]}
                    value={themeMode}
                    onChange={(v) => setThemeMode(v as ExportThemeMode)}
                  />
                </div>
              )}

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
              {formatHasHtmlOptions(format) && (
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Style"
                    description="Visual theme for the exported document"
                    labelPosition="left"
                    options={[
                      { value: 'modern', icon: "mdi mdi-text-short", label: 'Modern' },
                      { value: 'editorial', icon: "mdi mdi-feather", label: 'Editorial' },
                      { value: 'technical', icon: "mdi mdi-book-open-page-variant", label: 'Technical' },
                      { value: 'book', icon: "mdi mdi-book", label: 'Book' },
                    ]}
                    value={style}
                    onChange={(v) => setStyle(v as ExportStyle)}
                  />
                </div>
              )}
              {formatHasHtmlOptions(format) && (
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
              {formatHasHtmlOptions(format) && (
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
              {formatHasHtmlOptions(format) && (
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
              {formatHasHtmlOptions(format) && (
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
              {formatHasHtmlOptions(format) && (
                <div className="visibility-option">
                  <BooleanToggle
                    size="sm"
                    label="Cover page"
                    description="Render the first heading as a standalone title page"
                    labelPosition="left"
                    checked={coverPage}
                    onChange={(e) => setCoverPage(e.target.checked)}
                  />
                </div>
              )}
              {formatHasHtmlOptions(format) && (
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
                icon={qrGenerating ? undefined : "mdi mdi-qrcode"}
                onClick={handleGenerateQr}
                disabled={loading || !previewContent || downloading || qrGenerating}
              >
                {qrGenerating ? <Spinner size="sm" label="Generating…" /> : 'QR Code'}
              </Button>
            )}
            <Button
              variant="ghost"
              icon={copied ? "mdi mdi-check" : "mdi mdi-content-copy"}
              onClick={handleCopy}
              disabled={loading || !previewContent || downloading}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
            <Button
              variant="primary"
              icon={"mdi mdi-download"}
              onClick={handleDownload}
              disabled={downloading || loading}
            >
              {downloading ? <Spinner size="sm" label="Downloading…" /> : 'Download'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="export-modal__body">
        {/* Format tabs */}
        <div className="export-modal__tabs" role="tablist" aria-label="Export format">
          {getRegisteredExportFormats().map((def) => (
            <button
              key={def.format}
              role="tab"
              aria-selected={format === def.format}
              className={`export-modal__tab${
                format === def.format ? ' export-modal__tab--active' : ''
              }`}
              onClick={() => handleFormatChange(def.format as ExportFormat)}
            >
              {def.label}
            </button>
          ))}
        </div>

        {/* Preview area */}
        <div className="export-modal__preview-wrap">
          {error && (
            <div className="export-modal__error">{error}</div>
          )}

          {!formatHasHtmlOptions(format) ? (
            <textarea
              className={`export-modal__preview${loading ? ' export-modal__preview--loading' : ''}`}
              readOnly
              value={displayContent}
              spellCheck={false}
              aria-label={`${format} preview`}
            />
          ) : (
            <>
              {format === 'html' && (
                <div className="export-modal__view-toggle">
                  <button
                    type="button"
                    className={`export-modal__view-btn${htmlViewMode === 'preview' ? ' export-modal__view-btn--active' : ''}`}
                    onClick={() => setHtmlViewMode('preview')}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    className={`export-modal__view-btn${htmlViewMode === 'source' ? ' export-modal__view-btn--active' : ''}`}
                    onClick={() => setHtmlViewMode('source')}
                  >
                    Source
                  </button>
                </div>
              )}
              {format === 'html' && htmlViewMode === 'source' ? (
                <textarea
                  className={`export-modal__preview${loading ? ' export-modal__preview--loading' : ''}`}
                  readOnly
                  value={displayContent}
                  spellCheck={false}
                  aria-label="HTML source"
                />
              ) : (
                <div className={`export-modal__iframe-wrap${loading ? ' export-modal__iframe-wrap--loading' : ''}`}>
                  {displayContent && (
                    <iframe
                      className="export-modal__iframe"
                      title="Export preview"
                      srcDoc={displayContent}
                      sandbox="allow-same-origin"
                    />
                  )}
                </div>
              )}
              {format === 'pdf' && (
                <div className="export-modal__pdf-section">
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
                    rows={4}
                  />
                  <p className="export-modal__pdf-hint">
                    Optional CSS is injected before rendering to PDF.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Modal
        isOpen={qrModalOpen}
        onClose={() => setQrModalOpen(false)}
        title="QR Code"
        size="sm"
      >
        <div className="export-modal__qr-content">
          {qrError ? (
            <div className="export-modal__qr-error">{qrError}</div>
          ) : qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="QR Code"
              className="export-modal__qr-image"
            />
          ) : (
            <Spinner size="md" label="Generating QR code…" />
          )}
        </div>
      </Modal>
    </Modal>
  );
}
