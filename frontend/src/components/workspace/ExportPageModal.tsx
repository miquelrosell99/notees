/**
 * ExportPageModal - Modal for exporting the current page
 *
 * Shows a format dropdown (Markdown, HTML, PDF) and triggers
 * a download via the existing /api/export/{node_id} endpoint.
 */
import { useState, useCallback } from 'react';
import { mdiExport } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import api from '@/api/client';
import './ExportPageModal.css';

type ExportFormat = 'markdown' | 'html' | 'pdf';

interface ExportPageModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The node ID of the page to export */
  nodeId: number;
}

const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: 'markdown', label: 'Markdown (.md)' },
  { value: 'html', label: 'HTML (.html)' },
  { value: 'pdf', label: 'PDF (.pdf)' },
];

export function ExportPageModal({ isOpen, onClose, nodeId }: ExportPageModalProps) {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setError(null);

    try {
      const response = await api.get(`/export/${nodeId}`, {
        params: { format, include_children: true },
        responseType: 'blob',
      });

      // Extract filename from Content-Disposition header
      const disposition = response.headers['content-disposition'] as string | undefined;
      let filename = `export.${format === 'markdown' ? 'md' : format}`;
      if (disposition) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];
      }

      // Trigger download
      const url = URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [nodeId, format, onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Export Page"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={exporting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleExport}
            disabled={exporting}
            icon={mdiExport}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </>
      }
    >
      <div className="export-page__body">
        <label className="export-page__label" htmlFor="export-format-select">
          Format
        </label>
        <select
          id="export-format-select"
          className="export-page__select"
          value={format}
          onChange={(e) => setFormat(e.target.value as ExportFormat)}
          disabled={exporting}
        >
          {FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {error && <div className="export-page__error">{error}</div>}
      </div>
    </Modal>
  );
}
