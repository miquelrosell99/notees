/**
 * TaskProgress — Reusable progress bar with status text.
 *
 * Used by ImportOptionsModal, ImportLogseqModal, and any future task
 * that needs to show a progress indicator inside a modal body.
 */
import './TaskProgress.css';

interface TaskProgressProps {
  /** 0–100 */
  progress: number;
  /** Current status label, e.g. "Importing pages…" */
  statusText?: string;
  /** Optional error message shown below the bar */
  error?: string;
}

export function TaskProgress({ progress, statusText, error }: TaskProgressProps) {
  return (
    <div className="task-progress">
      <div className="task-progress__track">
        <div
          className="task-progress__fill"
          style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }}
        />
      </div>
      <div className="task-progress__text">
        <span>{progress}%</span>
        {statusText && <span className="task-progress__status">{statusText}</span>}
      </div>
      {error && <div className="task-progress__error">{error}</div>}
    </div>
  );
}

