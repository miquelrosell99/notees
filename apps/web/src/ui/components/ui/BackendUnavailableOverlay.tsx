/**
 * BackendUnavailableOverlay — degraded UX when the backend is unreachable
 *
 * Shows a dismissible warning banner for short outages. The full-screen lock
 * is reserved for when the user has explicitly dismissed the banner while the
 * backend is still down.
 */

import { useState } from "react";
import { Spinner } from "../modals/Spinner.js";
import { Icon } from "../../Icon.js";
import type { SyncStatusSnapshot } from "@/core/workspace-client.js";
import "./BackendUnavailableOverlay.css";

export interface BackendUnavailableOverlayProps {
  /** The live sync status snapshot (null before the first poll lands). */
  syncStatus: SyncStatusSnapshot | null;
}

export function BackendUnavailableOverlay({ syncStatus }: BackendUnavailableOverlayProps) {
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const healthy = syncStatus?.status !== "error";

  if (healthy) {
    return null;
  }

  const showLock = bannerDismissed;

  if (!showLock) {
    return (
      <div className="backend-unavailable-banner" role="status" aria-live="polite">
        <Icon path="mdi-alert-outline" className="backend-unavailable-banner__icon" />
        <span className="backend-unavailable-banner__text">
          Backend unreachable — working locally until it recovers.
        </span>
        <button type="button" className="backend-unavailable-banner__dismiss" onClick={() => setBannerDismissed(true)}>
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
