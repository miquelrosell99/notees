/**
 * BackendUnavailableOverlay — degraded UX when the backend is unreachable
 *
 * Shows a dismissible warning banner for short outages. The full-screen lock is
 * reserved for outages that persist past a threshold or when the user has
 * explicitly dismissed the banner and the backend is still down.
 */
import { useConnectionStore } from '@/stores/connectionStore';
import { Spinner } from './Spinner';
import { Icon } from './Icon';
import './BackendUnavailableOverlay.css';

export function BackendUnavailableOverlay() {
  const healthy = useConnectionStore((state) => state.healthy);
  const lockUI = useConnectionStore((state) => state.lockUI);
  const bannerDismissed = useConnectionStore((state) => state.bannerDismissed);
  const markBannerDismissed = useConnectionStore((state) => state.markBannerDismissed);

  if (healthy !== false) {
    return null;
  }

  const showLock = lockUI || bannerDismissed;

  if (!showLock) {
    return (
      <div className="backend-unavailable-banner" role="status" aria-live="polite">
        <Icon path="mdi-alert-outline" className="backend-unavailable-banner__icon" />
        <span className="backend-unavailable-banner__text">
          Backend unreachable — working locally until it recovers.
        </span>
        <button
          type="button"
          className="backend-unavailable-banner__dismiss"
          onClick={markBannerDismissed}
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div
      className="backend-unavailable-overlay"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Backend is unavailable"
    >
      <div className="backend-unavailable-overlay__content">
        <Spinner size="lg" />
        <h1 className="backend-unavailable-overlay__title">Backend is unreachable</h1>
        <p className="backend-unavailable-overlay__message">
          Working locally is no longer safe. The UI will unlock automatically once the backend recovers.
        </p>
      </div>
    </div>
  );
}
