/**
 * BackendUnavailableOverlay — degraded UX when the backend is unreachable
 *
 * Escalation ladder, one explicit user choice per rung:
 *
 *  1. Banner — a dismissible warning for short outages ("working locally
 *     until it recovers").
 *  2. Lock   — dismissing the banner while the backend is still down swaps
 *     the banner for a full-screen lock: past the grace period, new edits
 *     only pile into this browser's storage, so the UI stops rather than
 *     pile up silently. The lock carries the escape hatch — "Continue
 *     anyway" — next to an honest statement of what continued local work
 *     risks (local-only backlog lost with site data; conflicts after a long
 *     gap resolve by LWW/OR-set rules, not intent).
 *  3. Persistent banner — escaping the lock returns to the shell under a
 *     non-dismissible banner until the backend recovers, so the degraded
 *     state can never render invisibly.
 *
 * Recovery resets the ladder: the next outage starts again at rung 1.
 */

import { useEffect, useState } from "react";
import { Spinner } from "./Spinner.js";
import { Icon } from "../../Icon.js";
import { Button } from "./Button.js";
import type { SyncStatusSnapshot } from "@/core/workspace-client.js";
import "./BackendUnavailableOverlay.css";

export interface BackendUnavailableOverlayProps {
  /** The live sync status snapshot (null before the first poll lands). */
  syncStatus: SyncStatusSnapshot | null;
}

export function BackendUnavailableOverlay({ syncStatus }: BackendUnavailableOverlayProps) {
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [continuedAnyway, setContinuedAnyway] = useState(false);

  const healthy = syncStatus?.status !== "error";

  // Recovery resets the ladder — a new outage starts at the dismissible
  // banner, never at a stale lock earned by dismissing a previous one.
  useEffect(() => {
    if (healthy) {
      setBannerDismissed(false);
      setContinuedAnyway(false);
    }
  }, [healthy]);

  if (healthy) {
    return null;
  }

  if (continuedAnyway) {
    return (
      <div className="backend-unavailable-banner" role="status" aria-live="polite">
        <Icon path="mdi-alert-outline" className="backend-unavailable-banner__icon" />
        <span className="backend-unavailable-banner__text">
          Backend unreachable — working locally. Edits sync when it recovers.
        </span>
      </div>
    );
  }

  if (!bannerDismissed) {
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
          Working locally is no longer safe — new edits would only pile up in this browser's
          storage, invisible to your other devices.
        </p>
        <p className="backend-unavailable-overlay__warning">
          If you continue anyway, your edits stay on this device and sync when the backend
          recovers — but clearing this site's data first loses them, and if the same content
          changes elsewhere in the meantime, the conflict resolves by last-writer-wins, not by
          what you meant.
        </p>
        <div className="backend-unavailable-overlay__actions">
          <Button variant="danger" hapticIntensity="medium" onClick={() => setContinuedAnyway(true)}>
            Continue anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
