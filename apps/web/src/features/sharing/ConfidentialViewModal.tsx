/**
 * ConfidentialViewModal — opening a password-sealed share from the Shares
 * hub: the addressee types the out-of-band password, the artifact is fetched
 * (ciphertext only) and decrypted LOCALLY (scrypt → AES-GCM), and the
 * render rides a sandboxed iframe — GCM auth already guaranteed the bytes'
 * integrity, the sandbox keeps the (no-JS by construction) document inert,
 * and a wrong password fails loudly before anything renders.
 */

import { useState } from "react";

import { Modal } from "../../components/ui/kit/Modal.js";
import { Button } from "../../components/ui/kit/Button.js";
import { Spinner } from "../../components/ui/kit/Spinner.js";
import { openConfidentialArtifact } from "./confidentialCrypto.js";
import { fetchConfidentialArtifact, type ConfidentialShareEntry } from "./shareApi.js";

export function ConfidentialViewModal({
  serverUrl,
  credential,
  share,
  onClose,
}: {
  serverUrl: string;
  credential: string;
  share: ConfidentialShareEntry;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);

  async function handleOpen() {
    setBusy(true);
    setError(null);
    try {
      const sealed = await fetchConfidentialArtifact(serverUrl, credential, share.id);
      const bytes = await openConfidentialArtifact(
        sealed.artifact,
        password,
        sealed.salt,
        sealed.kdf,
      );
      setHtml(new TextDecoder().decode(bytes));
    } catch {
      // GCM auth failure (wrong password) and network errors both land here
      // — the honest message covers the common case.
      setError("Wrong password, or the share could not be fetched.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={share.displayName} size="lg">
      {html === null ? (
        <div className="nt-confidential__unlock">
          <p className="nt-share__hint">
            Sealed by {share.grantedByEmail ?? "the workspace owner"}. Enter the password they
            shared with you out of band — it never leaves this device.
          </p>
          <div className="nt-share__people-form">
            <input
              type="password"
              className="nt-share__people-input"
              placeholder="Password"
              aria-label="Confidential share password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleOpen();
              }}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy || password.length === 0}
              onClick={() => void handleOpen()}
            >
              {busy ? "Opening…" : "Open"}
            </Button>
          </div>
          {busy && (
            <div className="nt-share__loading">
              <Spinner />
            </div>
          )}
          {error !== null && <p className="nt-error">{error}</p>}
        </div>
      ) : (
        <iframe
          title={share.displayName}
          className="nt-confidential__frame"
          sandbox=""
          srcDoc={html}
        />
      )}
    </Modal>
  );
}
