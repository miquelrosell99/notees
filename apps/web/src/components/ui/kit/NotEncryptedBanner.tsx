/**
 * NotEncryptedBanner — the deliberate-keying surface for a plaintext workspace.
 *
 * Shown only on POSITIVE knowledge that the open workspace carries no wrapped
 * key (the key route answered 404, or an API-key session's listing row
 * reports `encrypted: false`) — never on a guess. Copy is pinned: the
 * warning names the exposure ("new content is readable on the server"), the
 * Key action is the one open-time keying path besides creation
 * (`ensureWorkspaceKey` — generate + wrap + PUT, then the caller reconnects
 * so the engine seals from here on), and the post-keying state stays honest
 * about history: only content written before keying stays plaintext, because
 * the operation log is immutable. Session-local dismiss, never persisted.
 */

import { useState } from "react";
import { Icon } from "../../../ui/Icon.js";
import "./NotEncryptedBanner.css";

/**
 * Directional copy for the banner's keyless arm: an API-key session has no
 * master key to wrap with, so the Key action is disabled behind this — the
 * keying-context sibling of the creation flow's directional sentence (that
 * one names creating; this one names keying).
 */
export const WORKSPACE_KEYING_COPY =
  "Sign in with your email and password to key this workspace.";

export interface NotEncryptedBannerProps {
  /** The deliberate keying action — the caller ensures + reconnects. */
  onKey: () => void | Promise<void>;
  /** True when this session holds no master key (API-key sign-in): keying is impossible, the hint says why. */
  keyDisabled: boolean;
  /** The directional copy shown with a disabled Key action (`WORKSPACE_KEYING_COPY`). */
  keyDisabledHint?: string | undefined;
  /** The keying landed: the honest post-keying copy replaces the warning (no Key action). */
  keyed?: boolean | undefined;
  /** Clears the caller's keyed notice (the keyed variant's Dismiss). */
  onDismissKeyed?: (() => void) | undefined;
}

export function NotEncryptedBanner({
  onKey,
  keyDisabled,
  keyDisabledHint,
  keyed = false,
  onDismissKeyed,
}: NotEncryptedBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (dismissed) return null;

  async function handleKey(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onKey();
    } catch (err) {
      // A failed keying keeps the banner open and names the failure — the
      // workspace is still plaintext and the exposure warning stands.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  if (keyed) {
    return (
      <div
        className="not-encrypted-banner not-encrypted-banner--keyed"
        role="status"
        aria-live="polite"
      >
        <Icon path="mdi-check-circle-outline" className="not-encrypted-banner__icon" />
        <span className="not-encrypted-banner__text">
          New content is encrypted. Content written before keying is not.
        </span>
        <button
          type="button"
          className="not-encrypted-banner__dismiss"
          onClick={() => {
            if (onDismissKeyed !== undefined) onDismissKeyed();
            else setDismissed(true);
          }}
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="not-encrypted-banner" role="status" aria-live="polite">
      <Icon path="mdi-alert-outline" className="not-encrypted-banner__icon" />
      <span className="not-encrypted-banner__text">
        This workspace is not encrypted — new content is readable on the server.
      </span>
      {keyDisabled && keyDisabledHint !== undefined && (
        <span className="not-encrypted-banner__hint">{keyDisabledHint}</span>
      )}
      {error !== null && <span className="not-encrypted-banner__error">{error}</span>}
      <button
        type="button"
        className="not-encrypted-banner__key"
        disabled={keyDisabled || pending}
        onClick={() => void handleKey()}
      >
        {pending ? "Keying…" : "Key this workspace"}
      </button>
      <button
        type="button"
        className="not-encrypted-banner__dismiss"
        onClick={() => setDismissed(true)}
      >
        Dismiss
      </button>
    </div>
  );
}
