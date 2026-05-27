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
import { SelectionRadio, type RadioOption } from '@/components/core/SelectionRadio';
import { exportWorkspaceFormat } from '@/api/workspaces';
import { downloadBlob } from '@/utils/download';
import './WorkspaceExportModal.css';

export interface WorkspaceExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceUuid: string;
  workspaceName: string;
}

type ExportFormat = 'dump' | 'markdown' | 'text' | 'json';

const FORMAT_OPTIONS: RadioOption[] = [
  {
    value: 'dump',
    label: 'Notees Dump',
    description: 'Full JSON dump with all nodes, links, properties, and settings. Best for backups.',
    badge: 'json',
  },
  {
    value: 'markdown',
    label: 'Markdown',
    description: 'All pages as .md files with YAML frontmatter. Great for portability.',
    badge: 'zip',
  },
  {
    value: 'text',
    label: 'Plain Text',
    description: 'All pages as .txt files. Simple and readable.',
    badge: 'zip',
  },
  {
    value: 'json',
    label: 'JSON AST',
    description: 'All pages as .json files with raw AST. Useful for data migration.',
    badge: 'zip',
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

  const handleFormatChange = useCallback((f: string) => {
    setFormat(f as ExportFormat);
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Export Workspace"
      size="md"
      className="workspace-export"
      footer={
        <div className="workspace-export__footer">
          <Button variant="default" onClick={onClose} disabled={downloading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="mdi mdi-download"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? 'Exporting…' : 'Export'}
          </Button>
        </div>
      }
    >
      <div className="workspace-export__body">
        {/* Format selection */}
        <div className="workspace-export__field-group">
          <span className="workspace-export__section-label">Export format</span>
          <SelectionRadio
            options={FORMAT_OPTIONS}
            value={format}
            onChange={handleFormatChange}
            layout="vertical"
            disabled={downloading}
          />
        </div>

        {/* Options */}
        <div className="workspace-export__field-group">
          <span className="workspace-export__section-label">Options</span>
          <BooleanToggle
            size="sm"
            label="Include assets"
            description={
              format === 'markdown'
                ? 'Include asset files in the ZIP and rewrite links to use relative paths.'
                : 'Include asset files in the ZIP when available.'
            }
            labelPosition="left"
            checked={includeAssets}
            onChange={(e) => setIncludeAssets(e.target.checked)}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="workspace-export__error">{error}</div>
        )}
      </div>
    </Modal>
  );
}
