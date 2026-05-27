/**
 * WorkspaceExportModal — Modal for exporting a workspace in various formats.
 *
 * Uses an async job pattern: creates a job, polls for progress, then downloads.
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { BooleanToggle } from '@/components/core/BooleanToggle';
import { SelectionRadio, type RadioOption } from '@/components/core/SelectionRadio';
import { SyncIcon } from '@/components/core/icons';
import {
  createExportJob,
  getExportJob,
  downloadExportJob,
  type ExportJob,
} from '@/api/workspaces';
import { downloadBlob } from '@/utils/download';
import './WorkspaceExportModal.css';

export interface WorkspaceExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceUuid: string;
  workspaceName: string;
}

type ExportFormat = 'dump' | 'markdown' | 'text' | 'json';

function getFormatOptions(includeAssets: boolean): RadioOption[] {
  return [
    {
      value: 'dump',
      label: 'Notees Dump',
      description: 'Full JSON dump with all nodes, links, properties, and settings. Best for backups.',
      badge: includeAssets ? 'zip' : 'json',
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
}

function getFileExtension(format: ExportFormat, includeAssets: boolean): string {
  if (format === 'dump' && !includeAssets) return 'json';
  return 'zip';
}

export function WorkspaceExportModal({
  isOpen,
  onClose,
  workspaceUuid,
  workspaceName,
}: WorkspaceExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>('dump');
  const [includeAssets, setIncludeAssets] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formatOptions = useMemo(() => getFormatOptions(includeAssets), [includeAssets]);

  const handleFormatChange = useCallback((f: string) => {
    setFormat(f as ExportFormat);
    setError(null);
  }, []);

  const handleStartExport = useCallback(async () => {
    setError(null);
    try {
      const { job_id } = await createExportJob(workspaceUuid, format, includeAssets);
      setJobId(job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start export');
    }
  }, [workspaceUuid, format, includeAssets]);

  const handleReset = useCallback(() => {
    setJobId(null);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    handleReset();
    onClose();
  }, [handleReset, onClose]);

  // Poll job status when we have an active job
  const { data: job } = useQuery<ExportJob>({
    queryKey: ['export-job', jobId],
    queryFn: () => getExportJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 500;
      if (data.status === 'completed' || data.status === 'failed') return false;
      return 500;
    },
  });

  // Handle job state transitions (completed → download, failed → error)
  useEffect(() => {
    if (!job) return;

    if (job.status === 'completed') {
      const doDownload = async () => {
        try {
          const blob = await downloadExportJob(job.id);
          const suffix = format === 'dump' ? 'dump' : format;
          const ext = getFileExtension(format, includeAssets);
          const filename = `${workspaceName}_${suffix}.${ext}`;
          downloadBlob(blob, filename);
          handleClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Download failed');
          setJobId(null);
        }
      };
      doDownload();
    }

    if (job.status === 'failed') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync local state with polled job result
      setError(job.error ?? 'Export failed');
      setJobId(null);
    }
  }, [job, format, includeAssets, workspaceName, handleClose]);

  const isExporting = !!jobId && job && job.status !== 'completed' && job.status !== 'failed';

  const progressLabel = useMemo(() => {
    if (!job) return 'Starting export…';
    return job.status_text;
  }, [job]);

  const progressValue = job?.progress ?? 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Export Workspace"
      size="md"
      className="workspace-export"
      footer={
        <div className="workspace-export__footer">
          <Button variant="default" onClick={handleClose} disabled={isExporting}>
            {isExporting ? 'Cancel' : 'Close'}
          </Button>
          {!jobId && (
            <Button
              variant="primary"
              icon="mdi mdi-download"
              onClick={handleStartExport}
            >
              Export
            </Button>
          )}
        </div>
      }
    >
      {isExporting ? (
        <div className="workspace-export__progress-overlay">
          <SyncIcon size="lg" className="workspace-export__progress-spin" />
          <div className="workspace-export__progress-track">
            <div
              className="workspace-export__progress-fill"
              style={{ width: `${Math.min(Math.max(progressValue, 0), 100)}%` }}
            />
          </div>
          <p className="workspace-export__progress-label">{progressLabel}</p>
          <span className="workspace-export__progress-percent">{progressValue}%</span>
        </div>
      ) : (
        <div className="workspace-export__body">
          {/* Format selection */}
          <div className="workspace-export__field-group">
            <span className="workspace-export__section-label">Export format</span>
            <SelectionRadio
              options={formatOptions}
              value={format}
              onChange={handleFormatChange}
              layout="vertical"
              disabled={isExporting}
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
                  : format === 'dump'
                    ? 'Include asset files in a ZIP alongside the JSON dump.'
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
      )}
    </Modal>
  );
}
