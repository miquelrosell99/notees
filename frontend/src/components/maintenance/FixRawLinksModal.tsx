/**
 * FixRawLinksModal - Convert raw [[uuid]] text to proper node_link AST nodes
 *
 * Provides a confirmation dialog before running the fix operation,
 * then displays a phase-based results report (same style as Logseq import).
 */
import { useState, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { TaskReport, type TaskPhaseResult } from '@/components/core/TaskReport';
import { fixRawUuidLinks, type FixRawUuidLinksResponse } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import './FixRawLinksModal.css';
import { Icon } from '@/components/core/icons';

interface FixRawLinksModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function buildPhases(result: FixRawUuidLinksResponse): TaskPhaseResult[] {
  const phases: TaskPhaseResult[] = [];

  // Phase 1: Scan nodes
  phases.push({
    label: 'Scan nodes for raw [[uuid]] text',
    succeeded: result.nodes_processed,
    failed: 0,
    errors: [],
  });

  // Phase 2: Convert links
  const convertErrors = result.errors.map(err => ({ item: 'Node', message: err }));
  phases.push({
    label: 'Convert raw links to node_link AST',
    succeeded: result.links_converted,
    failed: result.total_errors,
    errors: convertErrors,
  });

  // Phase 3: Update nodes
  phases.push({
    label: 'Update nodes with fixed content',
    succeeded: result.nodes_fixed,
    failed: 0,
    errors: [],
  });

  return phases;
}

export function FixRawLinksModal({ isOpen, onClose }: FixRawLinksModalProps) {
  const [isFixing, setIsFixing] = useState(false);
  const [result, setResult] = useState<FixRawUuidLinksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleConfirm = useCallback(async () => {
    setIsFixing(true);
    setError(null);
    try {
      const response = await fixRawUuidLinks();
      setResult(response);
      // Refetch all cached queries so the UI reflects updated node content and links
      // without requiring a page reload
      if (response.nodes_fixed > 0) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.all, refetchType: 'all' });
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.all, refetchType: 'all' });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fix raw UUID links');
    } finally {
      setIsFixing(false);
    }
  }, [queryClient]);

  const handleClose = useCallback(() => {
    setResult(null);
    setError(null);
    onClose();
  }, [onClose]);

  // Report view (after fix completes)
  if (result) {
    const phases = buildPhases(result);
    const totalSucceeded = result.nodes_fixed + result.links_converted;

    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Fix Raw UUID Links Report"
        size="lg"
        footer={
          <Button variant="primary" onClick={handleClose}>
            Close
          </Button>
        }
      >
        <TaskReport
          report={{
            phases,
            totalSucceeded,
            totalFailed: result.total_errors,
          }}
          successMessage="Fix completed successfully"
          warningMessage="Fix completed with errors"
        />
      </Modal>
    );
  }

  // Confirmation view (default)
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Fix Raw UUID Links"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={isFixing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={isFixing}
          >
            {isFixing ? 'Fixing…' : 'Proceed'}
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
              This command finds raw <code>[[uuid]]</code> text in block content and converts them into proper node links.
            </p>

            <div className="rebuild-links__warning">
              <Icon path={"mdi mdi-alert-circle-outline"} size={0.9} />
              <div>
                <strong>What this does:</strong>
                <ul>
                  <li>Scans all blocks for text containing <code>[[uuid]]</code> patterns</li>
                  <li>Resolves each UUID to an existing node</li>
                  <li>Replaces raw text with clickable node links</li>
                  <li>Rebuilds link records for affected nodes</li>
                </ul>
              </div>
            </div>

            <p className="rebuild-links__note">
              Use this command if you see raw UUID text like <code>[[67ceae53-1099-...]]</code> instead of proper node links.
              Unresolvable UUIDs (deleted nodes) are left unchanged.
            </p>

            {isFixing && (
              <div className="rebuild-links__progress">
                Scanning and fixing nodes, please wait...
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

