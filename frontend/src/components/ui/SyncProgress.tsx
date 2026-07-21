/**
 * SyncProgress — reusable sync progress presentation
 *
 * Extracted from LoadingScreen so the same spinner, label, rotating messages,
 * and progress bar can be rendered inside a fullscreen overlay or a modal.
 */
import { useEffect, useMemo, useState } from 'react';
import { Spinner } from './Spinner';
import './SyncProgress.css';

export interface SyncProgressProps {
  /** Text shown beneath the spinner (default: "Syncing…") */
  label?: string;
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

export function SyncProgress({
  label = 'Syncing…',
  className = '',
  progress,
  messages,
}: SyncProgressProps) {
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
    <div className={`sync-progress ${className}`} role="status" aria-busy="true" aria-label={label}>
      <div className="sync-progress__content">
        <Spinner size="lg" />
        {label && <span className="sync-progress__label">{label}</span>}
        {rotatingMessage && (
          <span className="sync-progress__message" aria-hidden="true">
            {rotatingMessage}
          </span>
        )}
        {progressPercent !== null && (
          <div className="sync-progress__progress" aria-hidden="true">
            <div
              className="sync-progress__progress-bar"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
