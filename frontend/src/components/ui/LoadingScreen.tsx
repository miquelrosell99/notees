/**
 * LoadingScreen — Full-page or inline loading overlay
 *
 * Used during app bootstrap, workspace switches, and lazy view loading.
 * Renders a centered spinner with an optional label.
 */
import { Spinner } from './Spinner';
import './LoadingScreen.css';

export interface LoadingScreenProps {
  /** Text shown beneath the spinner (default: "Loading…") */
  label?: string;
  /** Whether to fill the entire viewport (default: true) */
  fullscreen?: boolean;
  /** Additional className on the wrapper */
  className?: string;
  /** Optional progress fraction (0–1) to render a progress bar. */
  progress?: number;
}

export function LoadingScreen({
  label = 'Loading…',
  fullscreen = true,
  className = '',
  progress,
}: LoadingScreenProps) {
  const progressPercent =
    progress !== undefined ? Math.max(0, Math.min(1, progress)) * 100 : null;
  return (
    <div
      className={`loading-screen ${fullscreen ? 'loading-screen--fullscreen' : 'loading-screen--inline'} ${className}`}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <div className="loading-screen__content">
        <Spinner size="lg" />
        {label && <span className="loading-screen__label">{label}</span>}
        {progressPercent !== null && (
          <div className="loading-screen__progress" aria-hidden="true">
            <div
              className="loading-screen__progress-bar"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
