/**
 * Progress Component
 *
 * A determinate linear progress indicator: a labelled track whose fill
 * width tracks the clamped value/max fraction. Renders the honest state
 * only — there is no indeterminate mode (a moving bar that names no
 * number is a Spinner's job, see LoadingScreen's spinner/progress ladder).
 *
 * Thin fleet primitive with no catalog counterpart: the BEM register
 * (progress / progress__label / progress__track / progress__fill), the
 * ARIA progressbar wiring (role + the valuemin/valuemax/valuenow triple,
 * the visible label naming the bar via aria-labelledby), and the value
 * clamp all live here; every visual value resolves to a token in
 * Progress.css (the fill width alone is inline — it IS the value).
 *
 * The visual register follows the LoadingScreen progress ladder: a 6px capsule track on surface-container-highest, a
 * primary fill, width transitioned over the short motion token.
 *
 * Usage:
 * <Progress value={imported} max={total} label="Importing notes" />
 */
import { useId, type JSX } from 'react';
import { cn } from './cn.js';
import './Progress.css';

export interface ProgressProps {
  /** Current value; clamped into [0, max]. */
  value: number;
  /** Completion value; defaults to 1. Must be > 0. */
  max?: number;
  /** Visible + accessible label (rendered as text above the bar). */
  label?: string;
  className?: string;
}

export function Progress({ value, max = 1, label, className = '' }: ProgressProps): JSX.Element {
  const id = useId();
  // max <= 0 renders the honest empty state rather than dividing by zero
  // (the primitive never pretends progress it cannot measure).
  const determinate = max > 0;
  const clamped = determinate ? Math.min(Math.max(value, 0), max) : 0;
  const fillPercent = determinate ? (clamped / max) * 100 : 0;

  return (
    <div
      className={cn('progress', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={determinate ? max : 0}
      aria-valuenow={clamped}
      aria-labelledby={label ? `${id}-label` : undefined}
    >
      {label && (
        <span className="progress__label" id={`${id}-label`}>
          {label}
        </span>
      )}
      <div className="progress__track">
        <div className="progress__fill" style={{ width: `${fillPercent}%` }} />
      </div>
    </div>
  );
}
