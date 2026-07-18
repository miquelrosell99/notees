/**
 * FixRawLinksModal - Convert raw [[uuid]] text to proper node_link AST nodes
 *
 * Provides a confirmation dialog before running the fix operation,
 * then displays a phase-based results report (same style as Logseq import).
 */
import { useState, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TaskReport, type TaskPhaseResult } from '@/components/ui/TaskReport';
import { useWorkspaceStore } from '@/core/hooks';
import { fixRawUuidLinksInAST } from '@/lib/astBuilder';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/features/content';
import './FixRawLinksModal.css';
import { Icon } from '@/components/ui/icons';

interface FixRawLinksModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface FixResult {
  nodesProcessed: number;
  nodesFixed: number;
  linksConverted: number;
  totalErrors: number;
  errors: string[];
}

function buildPhases(result: FixResult): TaskPhaseResult[] {
  const phases: TaskPhaseResult[] = [];

  phases.push({
    label: 'Scan nodes for raw [[uuid]] text',
    succeeded: result.nodesProcessed,
    failed: 0,
    errors: [],
  });

  const convertErrors = result.errors.map((err) => ({ item: 'Node', message: err }));
  phases.push({
    label: 'Convert raw links to node_link AST',
    succeeded: result.linksConverted,
    failed: result.totalErrors,
    errors: convertErrors,
  });

  phases.push({
    label: 'Update nodes with fixed content',
    succeeded: result.nodesFixed,
    failed: 0,
    errors: [],
  });

  return phases;
}

export function FixRawLinksModal({ isOpen, onClose }: FixRawLinksModalProps) {
  const [isFixing, setIsFixing] = useState(false);
  const [result, setResult] = useState<FixResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');

  const handleConfirm = useCallback(async () => {
    setIsFixing(true);
    setError(null);
    try {
      if (!store) throw new Error('Workspace store is not ready');

      const rows = store.getDb().exec(
        'SELECT id, content FROM node WHERE content LIKE "%[[%" ESCAPE "\\"'
      );
      const candidates: { id: string; content: unknown[] }[] = [];
      for (const row of rows) {
        for (let i = 0; i < row.values.length; i++) {
          const id = String(row.values[i][0]);
          const content = JSON.parse(String(row.values[i][1])) as unknown[];
          candidates.push({ id, content });
        }
      }

      const fixResult: FixResult = {
        nodesProcessed: candidates.length,
        nodesFixed: 0,
        linksConverted: 0,
        totalErrors: 0,
        errors: [],
      };

      for (const candidate of candidates) {
        try {
          const resolved = fixRawUuidLinksInAST(candidate.content as never, (uuid) => {
            const target = store.getNode(uuid);
            if (!target) return null;
            return target.kind === 'class' ? 'class' : 'node';
          });
          if (resolved.changed) {
            store.updateContentAst(candidate.id, resolved.document as unknown[]);
            fixResult.nodesFixed++;
            fixResult.linksConverted += resolved.linksConverted;
          }
        } catch (e) {
          fixResult.totalErrors++;
          fixResult.errors.push(
            `${candidate.id}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      setResult(fixResult);
      if (fixResult.nodesFixed > 0) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.all, refetchType: 'all' });
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.all, refetchType: 'all' });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fix raw UUID links');
    } finally {
      setIsFixing(false);
    }
  }, [queryClient, store]);

  const handleClose = useCallback(() => {
    setResult(null);
    setError(null);
    onClose();
  }, [onClose]);

  // Report view (after fix completes)
  if (result) {
    const phases = buildPhases(result);
    const totalSucceeded = result.nodesFixed + result.linksConverted;

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
            totalFailed: result.totalErrors,
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
