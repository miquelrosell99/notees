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
}

export function LoadingScreen({
  label = 'Loading…',
  fullscreen = true,
  className = '',
}: LoadingScreenProps) {
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
      </div>
    </div>
  );
}
