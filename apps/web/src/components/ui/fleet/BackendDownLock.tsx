/**
 * BackendDownLock — the risk gate for a long backend outage
 *
 * The at-a-glance signal for "the backend is unreachable" is the sync badge
 * on the profile avatar (error state + the account popup's Sync entry), not
 * a banner — the shell stays clean through short outages. This component is
 * the one surface that can still interrupt: it renders the full-screen lock
 * once local work crosses from "briefly offline" into "genuinely at risk",
 * with the escape hatch — "Continue anyway" — next to an honest statement of
 * what continued local work risks (local-only backlog lost with site data;
 * conflicts after a long gap resolve by LWW/OR-set rules, not intent).
 *
 * The risk gate is two-pronged:
 *
 *  - Time — the outage has outlasted the grace period. Routine restarts and
 *    deploys on a self-hosted host finish well inside it; past it, edits
 *    have been piling device-local-only long enough that a wipe or conflict
 *    becomes a real scenario.
 *  - Volume — the local backlog (pending + failed ops) has crossed the
 *    threshold, regardless of how long the outage has lasted: a large
 *    unsynced pile is exactly what site-data clearing destroys.
 *
 * Either prong trips the lock; "Continue anyway" acknowledges the risk once
 * and returns to the shell (badge only) until the backend recovers. Recovery
 * resets the gate — the next outage is judged anew.
 */

import { useEffect, useState } from "react";
import { Spinner } from "./Spinner.js";
import { Button } from "./Button.js";
import type { SyncStatusSnapshot } from "@/core/workspace-client/index.js";
import "./BackendDownLock.css";

/** Outage duration past which local work is treated as at risk. */
export const OUTAGE_GRACE_MS = 10 * 60_000;

/** Unsynced op count (pending + failed) past which local work is at risk. */
export const RISK_BACKLOG_OPS = 200;

export interface BackendDownLockProps {
  /** The live sync status snapshot (null before the first poll lands). */
  syncStatus: SyncStatusSnapshot | null;
}

export function BackendDownLock({ syncStatus }: BackendDownLockProps) {
  const [downSince, setDownSince] = useState<number | null>(null);
  const [continuedAnyway, setContinuedAnyway] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const healthy = syncStatus?.status !== "error";
  const backlog = syncStatus ? syncStatus.pending + syncStatus.failed : 0;

  // Track the outage window; recovery resets both the window and the one-shot
  // acknowledgement so the next outage is gated anew.
  useEffect(() => {
    if (healthy) {
      setDownSince(null);
      setContinuedAnyway(false);
    } else if (downSince === null) {
      setDownSince(Date.now());
    }
  }, [healthy, downSince]);

  const atRisk =
    !healthy &&
    downSince !== null &&
    (backlog >= RISK_BACKLOG_OPS || now - downSince >= OUTAGE_GRACE_MS);

  // Tick once toward the grace boundary while the outage is still young, so
  // the lock appears on its own when the window expires (no polling needed).
  useEffect(() => {
    if (healthy || downSince === null || atRisk || continuedAnyway) return;
    const delay = OUTAGE_GRACE_MS - (Date.now() - downSince);
    const timer = setTimeout(() => setNow(Date.now()), Math.max(delay, 0) + 50);
    return () => clearTimeout(timer);
  }, [healthy, downSince, atRisk, continuedAnyway]);

  if (!atRisk || continuedAnyway) {
    return null;
  }

  return (
    <div
      className="backend-down-lock"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Backend is unavailable"
    >
      <div className="backend-down-lock__content">
        <Spinner size="lg" />
        <h1 className="backend-down-lock__title">Backend is unreachable</h1>
        <p className="backend-down-lock__message">
          Working locally is no longer safe — new edits would only pile up in this
          browser's storage, invisible to your other devices.
        </p>
        <p className="backend-down-lock__warning">
          If you continue anyway, your edits stay on this device and sync when the
          backend recovers — but clearing this site's data first loses them, and if
          the same content changes elsewhere in the meantime, the conflict resolves
          by last-writer-wins, not by what you meant.
        </p>
        <div className="backend-down-lock__actions">
          <Button variant="danger" hapticIntensity="medium" onClick={() => setContinuedAnyway(true)}>
            Continue anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
