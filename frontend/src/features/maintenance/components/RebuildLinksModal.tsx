/**
 * RebuildLinksModal - Rebuild node_link records from AST
 *
 * In the local-first architecture, text links and inline class links are
 * derived from AST content on every update. There is no separate link table
 * to rebuild, so this command now reports that consistency is maintained
 * automatically.
 */
import { useState, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TaskReport, type TaskPhaseResult } from '@/components/ui/TaskReport';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/features/content';
import './RebuildLinksModal.css';
import { Icon } from '@/components/ui/icons';

interface RebuildLinksModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface RebuildResult {
  nodesProcessed: number;
  linksCreated: number;
  inlineClassesCreated: number;
  totalErrors: number;
  errors: string[];
}

function buildPhases(result: RebuildResult): TaskPhaseResult[] {
  const phases: TaskPhaseResult[] = [];

  const mainErrors = result.errors.slice(0, 10).map((msg) => ({ item: '', message: msg }));
  phases.push({
    label: 'Process nodes',
    succeeded: result.linksCreated,
    failed: result.totalErrors,
    errors: mainErrors,
  });

  if (result.inlineClassesCreated > 0) {
    phases.push({
      label: 'Inline classes',
      succeeded: result.inlineClassesCreated,
      failed: 0,
      errors: [],
    });
  }

  return phases;
}

export function RebuildLinksModal({ isOpen, onClose }: RebuildLinksModalProps) {
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [result, setResult] = useState<RebuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleConfirm = useCallback(async () => {
    setIsRebuilding(true);
    setError(null);
    try {
      // Links are derived automatically from AST in the local-first store.
      // We still invalidate caches so any stale derived views refresh.
      queryClient.invalidateQueries({ queryKey: nodeKeys.all, refetchType: 'all' });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.all, refetchType: 'all' });

      setResult({
        nodesProcessed: 0,
        linksCreated: 0,
        inlineClassesCreated: 0,
        totalErrors: 0,
        errors: [],
      });
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
          totalSucceeded: result.linksCreated + result.inlineClassesCreated,
          totalFailed: result.totalErrors,
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
              In the local-first store, link records are derived automatically from AST content, so an explicit rebuild is not required.
            </p>

            <div className="rebuild-links__warning">
              <Icon path={"mdi mdi-alert-circle-outline"} size={0.9} />
              <div>
                <strong>What this does:</strong>
                <ul>
                  <li>Invalidates cached link-derived views</li>
                  <li>Forces a fresh derivation from current AST content</li>
                  <li>Preserves tag links and property links</li>
                </ul>
              </div>
            </div>

            <p className="rebuild-links__note">
              Use this command if link-derived views appear stale after a bulk import or migration.
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
