/**
 * RebuildLinksModal - Rebuild node_link table from AST
 *
 * Provides a confirmation dialog before running the rebuild operation,
 * then displays a results report similar to the EDN import.
 */
import { useState, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { rebuildAllLinks, type RebuildLinksResponse } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import './RebuildLinksModal.css';
import { Icon } from '@/components/core/icons';

interface RebuildLinksModalProps {
  isOpen: boolean;
  onClose: () => void;
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
    const hasErrors = result.total_errors > 0;
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
        <div className="rebuild-links__report">
          <div className={`rebuild-links__report-summary ${hasErrors ? 'rebuild-links__report-summary--warning' : 'rebuild-links__report-summary--success'}`}>
            <Icon path={hasErrors ? "mdi mdi-alert-circle-outline" : "mdi mdi-check-circle-outline"} size={1.2} />
            <div>
              <strong>{hasErrors ? 'Rebuild completed with errors' : 'Rebuild completed successfully'}</strong>
              <div className="rebuild-links__report-stats">
                <div className="rebuild-links__stat">
                  <span className="rebuild-links__stat-value">{result.nodes_processed}</span>
                  <span className="rebuild-links__stat-label">nodes processed</span>
                </div>
                <div className="rebuild-links__stat">
                  <span className="rebuild-links__stat-value">{result.links_created}</span>
                  <span className="rebuild-links__stat-label">text links created</span>
                </div>
                <div className="rebuild-links__stat">
                  <span className="rebuild-links__stat-value">{result.inline_classes_created}</span>
                  <span className="rebuild-links__stat-label">inline classes created</span>
                </div>
                {hasErrors && (
                  <div className="rebuild-links__stat rebuild-links__stat--error">
                    <span className="rebuild-links__stat-value">{result.total_errors}</span>
                    <span className="rebuild-links__stat-label">errors</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {result.errors.length > 0 && (
            <ErrorList errors={result.errors} totalErrors={result.total_errors} />
          )}
        </div>
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

function ErrorList({ errors, totalErrors }: { errors: string[]; totalErrors: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rebuild-links__errors">
      <div
        className="rebuild-links__errors-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(!expanded); }}
      >
        <span><strong>{totalErrors}</strong> error{totalErrors !== 1 ? 's' : ''}</span>
        <Icon path={expanded ? "mdi mdi-chevron-up" : "mdi mdi-chevron-down"} size={0.7} />
      </div>
      {expanded && (
        <ul className="rebuild-links__errors-list">
          {errors.map((err, i) => (
            <li key={i}>{err}</li>
          ))}
          {totalErrors > errors.length && (
            <li className="rebuild-links__errors-truncated">
              ... and {totalErrors - errors.length} more errors
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

