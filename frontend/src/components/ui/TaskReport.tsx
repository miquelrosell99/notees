/**
 * TaskReport — Reusable phase-based report with expandable error rows.
 *
 * Used by ImportOptionsModal, ImportLogseqModal, FixRawLinksModal, and
 * any future operation that produces a phase-by-phase summary.
 */
import { useState } from 'react';

import './TaskReport.css';
import { Icon } from '@/components/ui/icons';

// ── Types ─────────────────────────────────────────────────────

export interface TaskPhaseResult {
  label: string;
  succeeded: number;
  failed: number;
  errors: Array<{ item: string; message: string }>;
}

export interface TaskReportData {
  phases: TaskPhaseResult[];
  totalSucceeded: number;
  totalFailed: number;
}

// ── Props ─────────────────────────────────────────────────────

interface TaskReportProps {
  report: TaskReportData;
  /** Override the default "completed successfully" / "completed with errors" messages. */
  successMessage?: string;
  warningMessage?: string;
}

// ── Component ─────────────────────────────────────────────────

export function TaskReport({
  report,
  successMessage = 'Completed successfully',
  warningMessage = 'Completed with errors',
}: TaskReportProps) {
  const hasErrors = report.totalFailed > 0;

  return (
    <div className="task-report">
      <div
        className={`task-report__summary ${
          hasErrors ? 'task-report__summary--warning' : 'task-report__summary--success'
        }`}
      >
        <Icon
          path={hasErrors ? "mdi mdi-alert-circle-outline" : "mdi mdi-check-circle-outline"}
          size={1}
        />
        <div>
          <strong>{hasErrors ? warningMessage : successMessage}</strong>
          <span className="task-report__totals">
            {report.totalSucceeded} succeeded
            {report.totalFailed > 0 ? `, ${report.totalFailed} failed` : ''}
          </span>
        </div>
      </div>

      <div className="task-report__phases">
        {report.phases.map((phase, idx) => (
          <PhaseRow key={idx} phase={phase} />
        ))}
      </div>
    </div>
  );
}

// ── Phase row (collapsible error details) ─────────────────────

function PhaseRow({ phase }: { phase: TaskPhaseResult }) {
  const [expanded, setExpanded] = useState(false);
  const hasErrors = phase.failed > 0;
  const total = phase.succeeded + phase.failed;

  if (total === 0) return null;

  const headerClass = `task-report__phase-header ${
    hasErrors ? 'task-report__phase-header--error' : ''
  }`;

  const headerContent = (
    <>
      <span className="task-report__phase-label">{phase.label}</span>
      <span className="task-report__phase-counts">
        <span className="task-report__phase-ok">
          {phase.succeeded}{' '}
          <Icon path={"mdi mdi-check-circle-outline"} size={0.6} />
        </span>
        {hasErrors && (
          <>
            <span className="task-report__phase-fail">
              {phase.failed} failed
            </span>
            <Icon
              path={expanded ? "mdi mdi-chevron-up" : "mdi mdi-chevron-down"}
              size={0.7}
            />
          </>
        )}
      </span>
    </>
  );

  return (
    <div className="task-report__phase">
      {hasErrors ? (
        <button
          type="button"
          className={headerClass}
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {headerContent}
        </button>
      ) : (
        <div className={headerClass}>{headerContent}</div>
      )}
      {expanded && phase.errors.length > 0 && (
        <ul className="task-report__phase-errors">
          {phase.errors.map((err, i) => (
            <li key={i} className="task-report__phase-error">
              <strong>{err.item}</strong>: {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

