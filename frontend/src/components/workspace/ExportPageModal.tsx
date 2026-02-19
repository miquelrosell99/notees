/**
 * ExportPageModal - Modal for exporting a node
 *
 * Format-specific export experience:
 * - Markdown / HTML: readonly preview + copy-to-clipboard + download
 * - PDF: custom CSS textarea + download (saves HTML with CSS injected,
 *   ready for browser print-to-PDF)
 */
import { useState, useCallback, useEffect } from 'react';
import { mdiContentCopy, mdiDownload, mdiCheck } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import api from '@/api/client';
import './ExportPageModal.css';

type ExportFormat = 'markdown' | 'html' | 'pdf';

export interface ExportPageModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The node ID to export */
  nodeId: number;
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

export function ExportPageModal({ isOpen, onClose, nodeId }: ExportPageModalProps) {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [previewContent, setPreviewContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cssOverrides, setCssOverrides] = useState('');
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Fetch text preview when format changes (markdown / html only)
  useEffect(() => {
    if (!isOpen || format === 'pdf') {
      setPreviewContent('');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreviewContent('');

    api
      .get(`/export/${nodeId}`, {
        params: { format, include_children: true },
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
  }, [isOpen, format, nodeId]);

  const handleCopy = useCallback(() => {
    if (!previewContent) return;
    navigator.clipboard.writeText(previewContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [previewContent]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      if (format === 'pdf') {
        // Fetch HTML, inject CSS overrides, download as .html for print-to-PDF
        const response = await api.get(`/export/${nodeId}`, {
          params: { format: 'html', include_children: true },
          responseType: 'text',
        });
        let html = response.data as string;
        if (cssOverrides.trim()) {
          const styleTag = `<style>\n${cssOverrides.trim()}\n</style>`;
          html = html.includes('</head>')
            ? html.replace('</head>', `${styleTag}\n</head>`)
            : styleTag + '\n' + html;
        }
        triggerBlobDownload(new Blob([html], { type: 'text/html' }), 'export-print.html');
      } else {
        const response = await api.get(`/export/${nodeId}`, {
          params: { format, include_children: true },
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
  }, [format, nodeId, cssOverrides]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Export"
      size="lg"
      footer={
        <>
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
        </>
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
              onClick={() => setFormat(f)}
            >
              {f === 'markdown' ? 'Markdown' : f === 'html' ? 'HTML' : 'PDF'}
            </button>
          ))}
        </div>

        {/* Preview (markdown / html) */}
        {format !== 'pdf' && (
          <div className="export-modal__preview-wrap">
            {loading && (
              <div className="export-modal__status">Loading preview…</div>
            )}
            {error && (
              <div className="export-modal__error">{error}</div>
            )}
            {!loading && !error && (
              <textarea
                className="export-modal__preview"
                readOnly
                value={previewContent}
                spellCheck={false}
                aria-label={`${format} preview`}
              />
            )}
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
              Downloads an HTML file with your CSS applied. Open it in a browser
              and use{' '}&#8203;
              <kbd>Ctrl+P</kbd> / <kbd>⌘P</kbd> to save as PDF.
            </p>
            {error && <div className="export-modal__error">{error}</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ExportPageModal;
