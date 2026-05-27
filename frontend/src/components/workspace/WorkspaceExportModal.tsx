/**
 * WorkspaceExportModal — Modal for exporting a workspace in various formats.
 *
 * Supports:
 *   - Notees Dump (comprehensive JSON)
 *   - Markdown (ZIP of .md files with optional assets)
 *   - Plain Text (ZIP of .txt files)
 *   - JSON AST (ZIP of .json AST files)
 */
import { useState, useCallback } from 'react';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { BooleanToggle } from '@/components/core/BooleanToggle';
import { exportWorkspaceFormat } from '@/api/workspaces';
import { downloadBlob } from '@/utils/download';

export interface WorkspaceExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceUuid: string;
  workspaceName: string;
}

type ExportFormat = 'dump' | 'markdown' | 'text' | 'json';

interface FormatOption {
  value: ExportFormat;
  label: string;
  description: string;
  icon: string;
}

const FORMAT_OPTIONS: FormatOption[] = [
  {
    value: 'dump',
    label: 'Notees Dump',
    description: 'Full JSON dump with all nodes, links, properties, and settings. Best for backups.',
    icon: 'mdi mdi-database-export',
  },
  {
    value: 'markdown',
    label: 'Markdown',
    description: 'All pages as .md files with YAML frontmatter. Great for portability.',
    icon: 'mdi mdi-language-markdown',
  },
  {
    value: 'text',
    label: 'Plain Text',
    description: 'All pages as .txt files. Simple and readable.',
    icon: 'mdi mdi-text',
  },
  {
    value: 'json',
    label: 'JSON AST',
    description: 'All pages as .json files with raw AST. Useful for data migration.',
    icon: 'mdi mdi-code-json',
  },
];

export function WorkspaceExportModal({
  isOpen,
  onClose,
  workspaceUuid,
  workspaceName,
}: WorkspaceExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>('dump');
  const [includeAssets, setIncludeAssets] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFormatChange = useCallback((f: ExportFormat) => {
    setFormat(f);
    setError(null);
  }, []);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      const blob = await exportWorkspaceFormat(workspaceUuid, format, includeAssets);
      const suffix = format === 'dump' ? 'dump' : format;
      const ext = format === 'dump' ? 'json' : 'zip';
      const filename = `${workspaceName}_${suffix}.${ext}`;
      downloadBlob(blob, filename);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setDownloading(false);
    }
  }, [workspaceUuid, workspaceName, format, includeAssets, onClose]);

  const selectedFormat = FORMAT_OPTIONS.find((f) => f.value === format);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Export workspace: ${workspaceName}`}
      size="md"
      footer={
        <div className="workspace-export-modal__footer">
          <Button variant="ghost" onClick={onClose} disabled={downloading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="mdi mdi-download"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? 'Exporting…' : 'Download'}
          </Button>
        </div>
      }
    >
      <div className="workspace-export-modal__body">
        <div className="workspace-export-modal__section">
          <label className="workspace-export-modal__label">Export format</label>
          <div className="workspace-export-modal__formats" role="radiogroup" aria-label="Export format">
            {FORMAT_OPTIONS.map((option) => (
              <button
                key={option.value}
                role="radio"
                aria-checked={format === option.value}
                className={`workspace-export-modal__format-card${
                  format === option.value ? ' workspace-export-modal__format-card--active' : ''
                }`}
                onClick={() => handleFormatChange(option.value)}
              >
                <span className={`workspace-export-modal__format-icon ${option.icon}`} />
                <div className="workspace-export-modal__format-info">
                  <span className="workspace-export-modal__format-name">{option.label}</span>
                  <span className="workspace-export-modal__format-desc">{option.description}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="workspace-export-modal__section">
          <BooleanToggle
            size="sm"
            label="Include assets"
            description={
              selectedFormat?.value === 'markdown'
                ? 'Include asset files in the ZIP and rewrite links to use relative paths.'
                : 'Include asset files in the ZIP when available.'
            }
            labelPosition="left"
            checked={includeAssets}
            onChange={(e) => setIncludeAssets(e.target.checked)}
          />
        </div>

        {error && (
          <div className="workspace-export-modal__error">{error}</div>
        )}
      </div>
    </Modal>
  );
}
