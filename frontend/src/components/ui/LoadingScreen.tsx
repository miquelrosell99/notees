/**
 * LoadingScreen — Full-page or inline loading overlay
 *
 * Used during app bootstrap, workspace switches, and lazy view loading.
 * Renders a centered spinner with an optional label.
 */
import { SyncProgress } from './SyncProgress';
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
  /**
   * Optional list of messages that rotate while loading. Helps long waits feel
   * shorter. The first message is shown immediately and cycles every 3 seconds.
   */
  messages?: string[];
}

export function LoadingScreen({
  label = 'Loading…',
  fullscreen = true,
  className = '',
  progress,
  messages,
}: LoadingScreenProps) {
  return (
    <div
      className={`loading-screen ${fullscreen ? 'loading-screen--fullscreen' : 'loading-screen--inline'} ${className}`}
    >
      <SyncProgress label={label} progress={progress} messages={messages} />
    </div>
  );
}
