/**
 * FixRawLinksModal - Convert raw [[uuid]] text to proper node_link AST nodes
 *
 * Provides a confirmation dialog before running the fix operation,
 * then displays a phase-based results report (same style as Logseq import).
 */
import { useState, useCallback } from 'react';
import { mdiCheckCircleOutline, mdiAlertCircleOutline, mdiChevronDown, mdiChevronUp, mdiLinkVariant } from '@mdi/js';
import Icon from '@mdi/react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { fixRawUuidLinks, type FixRawUuidLinksResponse } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import '../workspace/ImportLogseqModal.css';
import './RebuildLinksModal.css';

interface FixRawLinksModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface PhaseResult {
  label: string;
  succeeded: number;
  failed: number;
  errors: Array<{ item: string; message: string }>;
}

function buildPhases(result: FixRawUuidLinksResponse): PhaseResult[] {
  const phases: PhaseResult[] = [];

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
      // Invalidate queries so the UI reflects updated node content and links
      if (response.nodes_fixed > 0) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.all });
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
    const hasErrors = result.total_errors > 0;

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
        <div className="import-logseq__report">
          <div className={`import-logseq__report-summary ${hasErrors ? 'import-logseq__report-summary--warning' : 'import-logseq__report-summary--success'}`}>
            <Icon path={hasErrors ? mdiAlertCircleOutline : mdiCheckCircleOutline} size={1} />
            <div>
              <strong>{hasErrors ? 'Fix completed with errors' : 'Fix completed successfully'}</strong>
              <span className="import-logseq__report-totals">
                {totalSucceeded} succeeded{result.total_errors > 0 ? `, ${result.total_errors} failed` : ''}
              </span>
            </div>
          </div>

          <div className="import-logseq__report-phases">
            {phases.map((phase, idx) => (
              <ReportPhaseRow key={idx} phase={phase} />
            ))}
          </div>
        </div>
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
            icon={mdiLinkVariant}
          >
            {isFixing ? 'Fixing…' : 'Fix Raw Links'}
          </Button>
        </>
      }
    >
      <div className="rebuild-links__body">
        {error && (
          <div className="rebuild-links__error">
            <Icon path={mdiAlertCircleOutline} size={1} />
            <span>{error}</span>
          </div>
        )}

        {!error && (
          <>
            <p className="rebuild-links__description">
              This command finds raw <code>[[uuid]]</code> text in block content and converts them into proper node links.
            </p>

            <div className="rebuild-links__warning">
              <Icon path={mdiAlertCircleOutline} size={0.9} />
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

function ReportPhaseRow({ phase }: { phase: PhaseResult }) {
  const [expanded, setExpanded] = useState(false);
  const hasErrors = phase.failed > 0;
  const total = phase.succeeded + phase.failed;

  if (total === 0) return null;

  return (
    <div className="import-logseq__phase">
      <div
        className={`import-logseq__phase-header ${hasErrors ? 'import-logseq__phase-header--error' : ''}`}
        onClick={() => hasErrors && setExpanded(!expanded)}
        role={hasErrors ? 'button' : undefined}
        tabIndex={hasErrors ? 0 : undefined}
        onKeyDown={(e) => { if (hasErrors && (e.key === 'Enter' || e.key === ' ')) setExpanded(!expanded); }}
      >
        <span className="import-logseq__phase-label">{phase.label}</span>
        <span className="import-logseq__phase-counts">
          <span className="import-logseq__phase-ok">{phase.succeeded} <Icon path={mdiCheckCircleOutline} size={0.6} /></span>
          {hasErrors && (
            <>
              <span className="import-logseq__phase-fail">{phase.failed} failed</span>
              <Icon path={expanded ? mdiChevronUp : mdiChevronDown} size={0.7} />
            </>
          )}
        </span>
      </div>
      {expanded && phase.errors.length > 0 && (
        <ul className="import-logseq__phase-errors">
          {phase.errors.map((err, i) => (
            <li key={i} className="import-logseq__phase-error">
              <strong>{err.item}</strong>: {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default FixRawLinksModal;
