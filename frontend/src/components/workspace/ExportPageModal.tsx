/**
 * ExportPageModal - Modal for exporting a node
 *
 * Format-specific export experience:
 * - Markdown / HTML: readonly preview + copy-to-clipboard + download
 * - PDF: custom CSS textarea + download (saves HTML with CSS injected,
 *   ready for browser print-to-PDF)
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { mdiContentCopy, mdiDownload, mdiCheck, mdiFileTree, mdiFileDocumentOutline, mdiTextShort, mdiBookOpenPageVariant, mdiTagOff, mdiTagOutline, mdiTagMultipleOutline, mdiViewHeadline, mdiViewCompact, mdiFormatListBulleted, mdiFormatListNumberedRtl, mdiFormatListNumbered, mdiFormatLetterCaseUpper, mdiFormatText, mdiCodeBraces, mdiCog, mdiArrowExpandHorizontal, mdiText, mdiBook, mdiViewColumn } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { SelectionButton } from '../core/SelectionButton';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { BooleanToggle } from '../core/BooleanToggle';
import api from '@/api/client';
import './ExportPageModal.css';

type ExportFormat = 'markdown' | 'html' | 'pdf';
type ExportLayout = 'outline' | 'flat';
type ExportStyle = 'minimal' | 'technical' | 'book';
type ExportProperties = 'none' | 'main' | 'all';
type ExportDensity = 'comfortable' | 'compact';
type ExportNumbering = 'none' | 'hierarchical' | 'legal' | 'appendix';
type ExportMeasure = 'full' | 'readable' | 'book' | 'two-column';

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

const STORAGE_KEY = 'export-css-overrides';

export function ExportPageModal({ isOpen, onClose, nodeUuid }: ExportPageModalProps) {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [layout, setLayout] = useState<ExportLayout>('outline');
  const [style, setStyle] = useState<ExportStyle>('minimal');
  const [properties, setProperties] = useState<ExportProperties>('main');
  const [density, setDensity] = useState<ExportDensity>('comfortable');
  const [numbering, setNumbering] = useState<ExportNumbering>('none');
  const [measure, setMeasure] = useState<ExportMeasure>('full');
  const [formatting, setFormatting] = useState(true);
  const [showUuid, setShowUuid] = useState(false);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cssOverrides, setCssOverrides] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? ''
  );
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Persist custom CSS overrides to localStorage whenever they change.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, cssOverrides);
  }, [cssOverrides]);

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
        params: { format, include_children: true, layout, formatting, style, properties, density, numbering, measure, show_uuid: showUuid },
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
  }, [isOpen, format, layout, formatting, style, properties, density, numbering, measure, showUuid, nodeUuid]);

  // For the HTML tab, show only the <body> inner content (no doctype/head/style)
  const displayContent = useMemo(() => {
    if (format !== 'html' || !previewContent) return previewContent;
    const match = previewContent.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    return match ? match[1].trim() : previewContent;
  }, [format, previewContent]);

  const handleCopy = useCallback(() => {
    if (!previewContent) return;
    const text = format === 'html' ? displayContent : previewContent;
    navigator.clipboard.writeText(text ?? '').then(() => {
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
          params: { format: 'html', include_children: true, layout, formatting, style, properties, density, numbering, measure, show_uuid: showUuid },
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
          params: { format, include_children: true, layout, formatting, style, properties, density, numbering, measure, show_uuid: showUuid },
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
  }, [format, layout, formatting, style, properties, density, numbering, measure, showUuid, nodeUuid, cssOverrides]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Export"
      size="lg"
      footer={
        <div className="export-modal__footer">
          <ButtonWithPanel
            icon={mdiCog}
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
                    { value: 'outline', icon: mdiFileTree, label: 'Outline' },
                    { value: 'flat', icon: mdiFileDocumentOutline, label: 'Flat' },
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
                      { value: 'minimal', icon: mdiTextShort, label: 'Minimal' },
                      { value: 'technical', icon: mdiBookOpenPageVariant, label: 'Technical' },
                      { value: 'book', icon: mdiBook, label: 'Book' },
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
                      { value: 'comfortable', icon: mdiViewHeadline, label: 'Comfortable' },
                      { value: 'compact', icon: mdiViewCompact, label: 'Compact' },
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
                      { value: 'full', icon: mdiArrowExpandHorizontal, label: 'Full' },
                      { value: 'readable', icon: mdiText, label: 'Readable' },
                      { value: 'book', icon: mdiBook, label: 'Book' },
                      { value: 'two-column', icon: mdiViewColumn, label: '2-column' },
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
                      { value: 'none', icon: mdiFormatListBulleted, label: 'None' },
                      { value: 'hierarchical', icon: mdiFormatListNumberedRtl, label: 'Hierarchical' },
                      { value: 'legal', icon: mdiFormatListNumbered, label: 'Legal' },
                      { value: 'appendix', icon: mdiFormatLetterCaseUpper, label: 'Appendix' },
                    ]}
                    value={numbering}
                    onChange={(v) => setNumbering(v as ExportNumbering)}
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
                    { value: 'true', icon: mdiFormatText, label: 'Formatted' },
                    { value: 'false', icon: mdiCodeBraces, label: 'Plain' },
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
                    { value: 'none', icon: mdiTagOff, label: 'None' },
                    { value: 'main', icon: mdiTagOutline, label: 'Main node' },
                    { value: 'all', icon: mdiTagMultipleOutline, label: 'All nodes' },
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
            </div>
          </ButtonWithPanel>
          <div className="export-modal__footer-actions">
            <Button variant="ghost" onClick={onClose} disabled={downloading}>
              Cancel
            </Button>
            {format !== 'pdf' && (
              <Button
                variant="ghost"
                icon={copied ? mdiCheck : mdiContentCopy}
                onClick={handleCopy}
                disabled={loading || !previewContent || downloading}
              >
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            )}
            <Button
              variant="primary"
              icon={mdiDownload}
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

export default ExportPageModal;
