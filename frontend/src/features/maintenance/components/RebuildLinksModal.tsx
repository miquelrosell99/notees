/**
 * RebuildLinksModal - Rebuild node_link table from AST
 *
 * Provides a confirmation dialog before running the rebuild operation,
 * then displays a phase-based results report using TaskReport.
 */
import { useState, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TaskReport, type TaskPhaseResult } from '@/components/ui/TaskReport';
import { rebuildAllLinks, type RebuildLinksResponse } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import './RebuildLinksModal.css';
import { Icon } from '@/components/ui/icons';

interface RebuildLinksModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function buildPhases(result: RebuildLinksResponse): TaskPhaseResult[] {
  const phases: TaskPhaseResult[] = [];

  const mainErrors = result.errors.slice(0, 10).map((msg) => ({ item: '', message: msg }));
  phases.push({
    label: 'Process nodes',
    succeeded: result.links_created,
    failed: result.total_errors,
    errors: mainErrors,
  });

  if (result.inline_classes_created > 0) {
    phases.push({
      label: 'Inline classes',
      succeeded: result.inline_classes_created,
      failed: 0,
      errors: [],
    });
  }

  return phases;
}

export function RebuildLinksModal({ isOpen, onClose }: RebuildLinksModalProps) {
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [result, setResult] = useState<RebuildLinksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleConfirm = useCallback(async () => {
    setIsRebuilding(true);
    setError(null);
    try {
      const response = await rebuildAllLinks();
      setResult(response);
      // Invalidate all node and view caches so links, breadcrumbs, etc. update
      if (response.links_created > 0) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.all, refetchType: 'all' });
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.all, refetchType: 'all' });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rebuild links');
    } finally {
      setIsRebuilding(false);
    }
  }, [queryClient]);

  const handleClose = useCallback(() => {
    setResult(null);
    setError(null);
    onClose();
  }, [onClose]);

  // Results view (after rebuild completes)
  if (result) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Rebuild Links Report"
        size="md"
        footer={
          <Button variant="primary" onClick={handleClose}>
            Close
          </Button>
        }
      >
        <TaskReport report={{
          phases: buildPhases(result),
          totalSucceeded: result.links_created + result.inline_classes_created,
          totalFailed: result.total_errors,
        }} />
      </Modal>
    );
  }

  // Confirmation view (default)
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Rebuild Links from AST"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={isRebuilding}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={isRebuilding}
            icon={"mdi mdi-database-refresh"}
          >
            {isRebuilding ? 'Rebuilding…' : 'Rebuild Links'}
          </Button>
        </>
      }
    >
      <div className="rebuild-links__body">
        {error && (
          <div className="rebuild-links__error">
            <Icon path={"mdi mdi-alert-circle-outline"} size={1} />
            <span>{error}</span>
          </div>
        )}

        {!error && (
          <>
            <p className="rebuild-links__description">
              This command will rebuild all link records in the database by re-parsing the AST content of every node.
            </p>

            <div className="rebuild-links__warning">
              <Icon path={"mdi mdi-alert-circle-outline"} size={0.9} />
              <div>
                <strong>What this does:</strong>
                <ul>
                  <li>Deletes all existing text links and inline class links</li>
                  <li>Re-parses every node's AST content</li>
                  <li>Recreates link records based on current content</li>
                  <li>Preserves tag links and property links</li>
                </ul>
              </div>
            </div>

            <p className="rebuild-links__note">
              Use this command if link data has become inconsistent after a migration or bulk operation.
              This operation is safe and can be run multiple times.
            </p>

            {isRebuilding && (
              <div className="rebuild-links__progress">
                Processing nodes, please wait...
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
