/**
 * BackendUnavailableOverlay — full-screen lock when the backend is unreachable
 *
 * Renders on top of the entire app while Postgres is recovering, the backend
 * container is restarting, or the Vite proxy returns 502. Blocks interaction
 * with the app underneath and polls until the backend returns.
 */
import { useConnectionStore } from '@/stores/connectionStore';
import { Spinner } from './Spinner';
import './BackendUnavailableOverlay.css';

export function BackendUnavailableOverlay() {
  const lockUI = useConnectionStore((state) => state.lockUI);

  if (!lockUI) {
    return null;
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
        <h1 className="backend-unavailable-overlay__title">Backend is starting…</h1>
        <p className="backend-unavailable-overlay__message">
          Waiting for the database. The UI will unlock automatically.
        </p>
      </div>
    </div>
  );
}
