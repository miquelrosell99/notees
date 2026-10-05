/**
 * InProcessStoreBanner — the §34.92 loud warning for the in-process store mode.
 *
 * Shown when detectStoreMode() falls back to WorkspaceClient (the Web Worker
 * store unavailable): every store read then runs synchronously on the UI
 * thread, so large workspaces can freeze the app (the profiled 75%-of-
 * capture jank). Session-local dismiss; detectStoreMode() also console.warns
 * with the specific missing capability for diagnosis.
 */

import { useState } from "react";
import { Icon } from "../../Icon.js";
import "./InProcessStoreBanner.css";

export function InProcessStoreBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="in-process-banner" role="status" aria-live="polite">
      <Icon path="mdi-alert-outline" className="in-process-banner__icon" />
      <span className="in-process-banner__text">
        Background store unavailable — running in-process, so large workspaces may freeze the UI.
      </span>
      <button
        type="button"
        className="in-process-banner__dismiss"
        onClick={() => setDismissed(true)}
      >
        Dismiss
      </button>
    </div>
  );
}
