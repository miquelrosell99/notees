/**
 * LoadingScreen — Full-page or inline loading overlay
 *
 * Used during app bootstrap, workspace switches, and lazy view loading.
 * Renders a centered spinner with an optional label.
 */
import { useEffect, useMemo, useState } from 'react';
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
  const progressPercent =
    progress !== undefined ? Math.max(0, Math.min(1, progress)) * 100 : null;

  const [messageIndex, setMessageIndex] = useState(0);
  const hasMessages = messages && messages.length > 0;

  useEffect(() => {
    if (!hasMessages) return;
    const id = setInterval(() => {
      setMessageIndex((i) => (i + 1) % messages.length);
    }, 3000);
    return () => clearInterval(id);
  }, [hasMessages, messages]);

  const rotatingMessage = useMemo(() => {
    if (!hasMessages) return null;
    return messages[messageIndex];
  }, [hasMessages, messages, messageIndex]);

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
        {rotatingMessage && (
          <span className="loading-screen__message" aria-hidden="true">
            {rotatingMessage}
          </span>
        )}
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
