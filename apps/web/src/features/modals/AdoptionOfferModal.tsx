/**
 * AdoptionOfferModal — the F2 offline→online publish offer.
 *
 * An offline-created workspace opened online against a server that has never
 * seen it pauses the open on this offer (the connect threw AdoptionOfferError
 * before any client existed). Confirming publishes the workspace under its
 * existing id — the custody device key's wrap under the master rides the
 * CREATE, so the backlog drains sealed on the reconnect — and the caller
 * reconnects. Keeping it local opens plaintext ("nothing changes": zero
 * writes). API-key sessions render the directional copy instead of the
 * action: the confirm needs a master key and an API-key session has no
 * password path to one.
 */

import { useEffect, useState } from "react";
import "./AdoptionOfferModal.css";
import { SECURE_CONTEXT_KEYING_COPY } from "../../core/crypto-custody.js";
import { Button } from "../../components/ui/kit/Button.js";
import { Modal } from "../../components/ui/kit/Modal.js";

export interface AdoptionOfferModalProps {
  isOpen: boolean;
  /** The workspace's name (display only). */
  workspaceName: string;
  /**
   * An API-key session has no password path to a master key: the publish is
   * replaced by copy directing to signing in with email + password.
   */
  apiKeySession?: boolean | undefined;
  /** Keep the workspace local: opens plaintext, publishes nothing. */
  onKeepLocal: () => void;
  /**
   * Publishes the workspace (the create-with-id + wrap). Resolves on success
   * (the caller reconnects); rejects with the error to display.
   */
  onPublish: () => Promise<void>;
}

export function AdoptionOfferModal({
  isOpen,
  workspaceName,
  apiKeySession = false,
  onKeepLocal,
  onPublish,
}: AdoptionOfferModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setPending(false);
    }
  }, [isOpen]);

  // Keying is secure-context-gated: without Web Crypto no wrap can happen —
  // the honest no-keying copy replaces the confirm, never a dead button that
  // dies on a raw crypto TypeError.
  const keyingUnavailable = globalThis.crypto?.subtle === undefined;

  async function handlePublish() {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await onPublish();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onKeepLocal} title="Publish this workspace?" size="sm">
      {apiKeySession ? (
        <div className="adoption-offer-modal">
          <p className="adoption-offer-modal__explain">
            <strong>{workspaceName}</strong> exists only on this device. Sessions signed in with
            an API key can&apos;t publish it — the publish wraps its key with your account password.
            Sign out and sign in with your email and password to publish it to the server.
          </p>
          <div className="adoption-offer-modal__actions">
            <Button type="button" variant="outline" onClick={onKeepLocal}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="adoption-offer-modal">
          <p className="adoption-offer-modal__explain">
            <strong>{workspaceName}</strong> exists only on this device. Publish it to the server?
            Its existing content and new content will be encrypted, and it will sync with your
            account.
          </p>
          {keyingUnavailable ? (
            <p className="adoption-offer-modal__error">{SECURE_CONTEXT_KEYING_COPY}</p>
          ) : null}
          {error !== null ? <p className="adoption-offer-modal__error">{error}</p> : null}
          <div className="adoption-offer-modal__actions">
            <Button type="button" variant="outline" onClick={onKeepLocal} disabled={pending}>
              Keep on this device
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void handlePublish()}
              disabled={pending || keyingUnavailable}
            >
              {pending ? "Publishing…" : "Publish workspace"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
