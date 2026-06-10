/**
 * Spinner — Reusable loading indicator
 *
 * A simple CSS-animated spinner for consistent loading states
 * across the application.
 */
import './Spinner.css';

export interface SpinnerProps {
  /** Spinner size (default: md) */
  size?: 'sm' | 'md' | 'lg';
  /** Optional label shown next to the spinner */
  label?: string;
  /** Center the spinner within its container (default: false) */
  centered?: boolean;
  /** Additional className on the wrapper */
  className?: string;
}

export function Spinner({ size = 'md', label, centered = false, className = '' }: SpinnerProps) {
  return (
    <span
      className={`spinner-wrapper spinner-wrapper--${size} ${centered ? 'spinner-wrapper--centered' : ''} ${className}`}
      role="status"
      aria-busy="true"
    >
      <span className={`spinner spinner--${size}`} aria-hidden="true" />
      {label && <span className="spinner-label">{label}</span>}
    </span>
  );
}
