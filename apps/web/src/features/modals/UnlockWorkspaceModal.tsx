/**
 * UnlockWorkspaceModal — the fail-loud open refusal for encrypted workspaces.
 *
 * A keyed workspace never opens keyless: when the connect finds no usable
 * key (the session reloaded without the master key — custody is memory-only —
 * or an API-key session has no password path at all), the open aborts and
 * this modal takes over. It asks for the account password, re-derives the
 * master key (the caller performs the login + derivation + reconnect), and
 * surfaces the failure modes distinctly: a wrong password (401 / verifier)
 * is a form error; the server-side lockout (429 with the retry-after
 * message) says to wait; anything else names itself. API-key sessions render
 * the directional copy instead of the form — only an email + password sign-in
 * can supply the key.
 */

import { useEffect, useState, type FormEvent } from "react";
import { AuthRequestError } from "../../core/auth-api.js";
import "./UnlockWorkspaceModal.css";
import { Button } from "../../components/ui/kit/Button.js";
import { Modal } from "../../components/ui/kit/Modal.js";
import { TextField } from "../../components/ui/kit/TextField.js";

export interface UnlockWorkspaceModalProps {
  isOpen: boolean;
  /** The account email (displayed; the password is what's asked). */
  email: string;
  /**
   * An API-key session has no password path: the form is replaced by copy
   * directing to signing in with email + password.
   */
  apiKeySession?: boolean | undefined;
  onClose: () => void;
  /**
   * Performs the unlock: re-login, derive the master key, re-open the
   * workspace. Resolves on success; rejects with the error to display.
   */
  onSubmit: (password: string) => Promise<void>;
}

export function UnlockWorkspaceModal({
  isOpen,
  email,
  apiKeySession = false,
  onClose,
  onSubmit,
}: UnlockWorkspaceModalProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setPassword("");
      setError(null);
      setPending(false);
    }
  }, [isOpen]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending || password === "") return;
    setError(null);
    setPending(true);
    try {
      await onSubmit(password);
      onClose();
    } catch (err) {
      if (err instanceof AuthRequestError && err.status === 429) {
        setError(`Too many attempts — try again in a moment. (${err.message})`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Unlock encrypted workspace" size="sm">
      {apiKeySession ? (
        <div className="unlock-workspace-modal">
          <p className="unlock-workspace-modal__explain">
            This workspace is encrypted, and sessions signed in with an API key can&apos;t
            unlock it. Sign out and sign in with your email and password to open it.
          </p>
          <div className="unlock-workspace-modal__actions">
            <Button type="button" variant="outline" onClick={onClose}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="unlock-workspace-modal">
          <p className="unlock-workspace-modal__explain">
            This workspace is encrypted — enter the password for <strong>{email}</strong>{" "}
            to open it. It was never opened without its key.
          </p>
          <TextField
            type="password"
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={error !== null}
            errorMessage={error ?? ""}
            disabled={pending}
          />
          <div className="unlock-workspace-modal__actions">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || password === ""}>
              {pending ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
