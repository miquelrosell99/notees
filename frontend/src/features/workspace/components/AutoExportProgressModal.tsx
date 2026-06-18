/**
 * Auto-export batch progress modal
 *
 * Shown when the user triggers a force re-export of all pages to markdown.
 * Polls the backend for progress and shows a determinate progress bar.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { autoExportBatch, getAutoExportStatus, type AutoExportStatus } from '@/features/workspace';
import { Modal } from '@/components/ui/Modal';
import { TaskProgress } from '@/components/ui/TaskProgress';
import { TaskReport } from '@/components/ui/TaskReport';
import type { TaskReportData } from '@/components/ui/TaskReport';
import { Button } from '@/components/ui/Button';
import { useNotifications } from '@/stores/notificationStore';

type ModalPhase = 'idle' | 'exporting' | 'done';

interface AutoExportProgressModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AutoExportProgressModal({ isOpen, onClose }: AutoExportProgressModalProps) {
  const [phase, setPhase] = useState<ModalPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<TaskReportData | undefined>(undefined);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { success: notifySuccess, error: notifyError } = useNotifications();

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startExport = useCallback(async () => {
    setPhase('exporting');
    setProgress(0);
    setStatusText('Starting export...');
    setError(undefined);
    setReport(undefined);

    try {
      await autoExportBatch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase('done');
      notifyError('Export failed', msg);
      return;
    }

    // Start polling status
    pollRef.current = setInterval(async () => {
      try {
        const status: AutoExportStatus = await getAutoExportStatus();
        if (status.total > 0) {
          const pct = Math.round((status.completed / status.total) * 100);
          setProgress(pct);
          setStatusText(
            status.current_page
              ? `Exporting ${status.current_page} (${status.completed}/${status.total})`
              : `Exporting... (${status.completed}/${status.total})`
          );
        }

        if (!status.running) {
          clearPoll();
          setPhase('done');
          if (status.error) {
            setError(status.error);
            setReport({
              phases: [
                {
                  label: 'Export pages',
                  succeeded: status.completed,
                  failed: 1,
                  errors: [{ item: 'Batch export', message: status.error }],
                },
              ],
              totalSucceeded: status.completed,
              totalFailed: 1,
            });
            notifyError('Export completed with errors', status.error);
          } else {
            setReport({
              phases: [
                {
                  label: 'Export pages',
                  succeeded: status.completed,
                  failed: 0,
                  errors: [],
                },
              ],
              totalSucceeded: status.completed,
              totalFailed: 0,
            });
            notifySuccess('Export complete', `${status.completed} pages exported to markdown`);
          }
        }
      } catch (pollErr: unknown) {
        const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
        clearPoll();
        setPhase('done');
        setError(msg);
        notifyError('Export failed', msg);
      }
    }, 800);
  }, [clearPoll, notifyError, notifySuccess]);

  useEffect(() => {
    if (isOpen && phase === 'idle') {
      startExport();
    }
    if (!isOpen) {
      clearPoll();
      setPhase('idle');
        setProgress(0);
        setStatusText('');
        setError(undefined);
        setReport(undefined);;
    }
    return () => clearPoll();
  }, [isOpen, phase, startExport, clearPoll]);

  const handleClose = useCallback(() => {
    clearPoll();
    onClose();
  }, [clearPoll, onClose]);

  if (phase === 'exporting') {
    return (
      <Modal isOpen={isOpen} onClose={handleClose} title="Exporting to Markdown" size="md">
        <TaskProgress progress={progress} statusText={statusText} error={error} />
      </Modal>
    );
  }

  if (phase === 'done' && report) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Export Report"
        size="md"
        footer={
          <Button variant="primary" onClick={handleClose}>
            Close
          </Button>
        }
      >
        <TaskReport
          report={report}
          successMessage="All pages exported to markdown successfully"
          warningMessage="Export completed with some errors"
        />
      </Modal>
    );
  }

  if (phase === 'done' && error) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Export Failed"
        size="md"
        footer={
          <Button variant="primary" onClick={handleClose}>
            Close
          </Button>
        }
      >
        <p>{error}</p>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Exporting to Markdown" size="md">
      <TaskProgress progress={0} statusText="Preparing..." />
    </Modal>
  );
}
