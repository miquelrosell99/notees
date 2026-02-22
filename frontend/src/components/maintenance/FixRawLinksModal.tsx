/**
 * FixRawLinksModal - Convert raw [[uuid]] text to proper node_link AST nodes
 *
 * Provides a confirmation dialog before running the fix operation,
 * then displays a results report.
 */
import { useState, useCallback } from 'react';
import { mdiCheckCircleOutline, mdiAlertCircleOutline, mdiChevronDown, mdiChevronUp, mdiLinkVariant } from '@mdi/js';
import Icon from '@mdi/react';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { fixRawUuidLinks, type FixRawUuidLinksResponse } from '@/api/nodes';
import './RebuildLinksModal.css';

interface FixRawLinksModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function FixRawLinksModal({ isOpen, onClose }: FixRawLinksModalProps) {
  const [isFixing, setIsFixing] = useState(false);
  const [result, setResult] = useState<FixRawUuidLinksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    setIsFixing(true);
    setError(null);
    try {
      const response = await fixRawUuidLinks();
      setResult(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fix raw UUID links');
    } finally {
      setIsFixing(false);
    }
  }, []);

  const handleClose = useCallback(() => {
    setResult(null);
    setError(null);
    onClose();
  }, [onClose]);

  // Results view (after fix completes)
  if (result) {
    const hasErrors = result.total_errors > 0;
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Fix Raw UUID Links Report"
        size="md"
        footer={
          <Button variant="primary" onClick={handleClose}>
            Close
          </Button>
        }
      >
        <div className="rebuild-links__report">
          <div className={`rebuild-links__report-summary ${hasErrors ? 'rebuild-links__report-summary--warning' : 'rebuild-links__report-summary--success'}`}>
            <Icon path={hasErrors ? mdiAlertCircleOutline : mdiCheckCircleOutline} size={1.2} />
            <div>
              <strong>{hasErrors ? 'Fix completed with errors' : 'Fix completed successfully'}</strong>
              <div className="rebuild-links__report-stats">
                <div className="rebuild-links__stat">
                  <span className="rebuild-links__stat-value">{result.nodes_processed}</span>
                  <span className="rebuild-links__stat-label">nodes scanned</span>
                </div>
                <div className="rebuild-links__stat">
                  <span className="rebuild-links__stat-value">{result.nodes_fixed}</span>
                  <span className="rebuild-links__stat-label">nodes fixed</span>
                </div>
                <div className="rebuild-links__stat">
                  <span className="rebuild-links__stat-value">{result.links_converted}</span>
                  <span className="rebuild-links__stat-label">links converted</span>
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
        <Icon path={expanded ? mdiChevronUp : mdiChevronDown} size={0.7} />
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

export default FixRawLinksModal;
