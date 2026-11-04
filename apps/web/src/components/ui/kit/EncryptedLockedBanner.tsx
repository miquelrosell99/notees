/**
 * EncryptedLockedBanner — the loud warning for an encrypted workspace opened
 * without its key.
 *
 * Shown when the workspace carries a wrapped key but this session has no
 * master key in memory (a reload restores the session without it — custody
 * is memory-only): the engine runs keyless, remote sealed envelopes are
 * skipped (never applied), and LOCAL WRITES ARE PLAINTEXT until unlocked.
 * The Unlock affordance appears when the host passes `onUnlock` (the unlock
 * re-prompt re-derives the master key and re-opens the workspace).
 */

import { useState } from "react";
import { Icon } from "../../../ui/Icon.js";
import "./EncryptedLockedBanner.css";

export function EncryptedLockedBanner({ onUnlock }: { onUnlock?: (() => void) | undefined }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="encrypted-locked-banner" role="status" aria-live="polite">
      <Icon path="mdi-lock-open-variant-outline" className="encrypted-locked-banner__icon" />
      <span className="encrypted-locked-banner__text">
        This workspace is encrypted, but this session has no key — enter your password below to
        unlock. Until then writes are plaintext and sealed remote changes are skipped.
      </span>
      {onUnlock !== undefined && (
        <button type="button" className="encrypted-locked-banner__unlock" onClick={onUnlock}>
          Unlock
        </button>
      )}
      <button
        type="button"
        className="encrypted-locked-banner__dismiss"
        onClick={() => setDismissed(true)}
      >
        Dismiss
      </button>
    </div>
  );
}
