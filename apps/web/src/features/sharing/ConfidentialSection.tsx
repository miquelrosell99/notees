/**
 * ConfidentialSection — the Share modal's confidential half (the parked
 * §3.3's READ-only half shipped): seal this node's subtree render under a
 * PASSWORD the owner shares out of band, addressed to an email. The server
 * stores ONLY the ciphertext + the KDF salt/params — the password never
 * reaches any route, and the addressee needs no membership on this
 * workspace: an account matching the email + the password is the whole
 * capability (the inbox carries the row; decryption fails GCM auth locally
 * on a wrong password — never a partial render).
 *
 * Edit over confidential shares stays parked (the shadow-workspace bridge) —
 * this is the read half, and the section says so honestly.
 */

import { useState } from "react";

import { Button } from "../../components/ui/kit/Button.js";
import { blobBytes } from "../../core/workspace-client/asset-transport.js";
import { exportSubtreeFile, freshSubtreeSurface, type ExportClient } from "../export/exportSubtree.js";
import { sealConfidentialHtml } from "./confidentialCrypto.js";
import { createConfidentialShare } from "./shareApi.js";

export function ConfidentialSection({
  serverUrl,
  token,
  nodeUuid,
  nodeName,
  client,
}: {
  serverUrl: string;
  token: string;
  nodeUuid: string;
  nodeName: string | undefined;
  /** The store client — renders the subtree. Absent in bare tests: disabled. */
  client: ExportClient | undefined;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (client === undefined) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      // The sealed artifact must carry the WHOLE subtree — the render reads
      // the fresh subtree surface (never the render cache, which drops
      // folded / off-screen descendants the same way the clipboard did).
      const surface = await freshSubtreeSurface(client, [nodeUuid]);
      const exported = await exportSubtreeFile(surface, nodeUuid, { format: "html" });
      const html = await blobBytes(exported.blob);
      const sealed = await sealConfidentialHtml(html, password);
      await createConfidentialShare(serverUrl, token, {
        nodeId: nodeUuid,
        recipientEmail: email.trim(),
        displayName: nodeName !== undefined && nodeName.length > 0 ? nodeName : "Shared page",
        artifact: sealed.artifact,
        salt: sealed.salt,
        kdf: sealed.kdf,
      });
      setDone(true);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="nt-share__people" aria-label="Confidential share">
      <h3 className="nt-share__people-title">Confidential share</h3>
      <p className="nt-share__hint">
        For someone with NO access to this workspace: the page is sealed with a password only the
        two of you know — the server stores only the ciphertext. They can read it, not edit it.
      </p>
      <div className="nt-share__people-form">
        <input
          type="email"
          className="nt-share__people-input"
          placeholder="person@example.com"
          aria-label="Confidential recipient email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <input
          type="password"
          className="nt-share__people-input"
          placeholder="Password"
          aria-label="Confidential password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || client === undefined || email.trim().length === 0 || password.length === 0}
          onClick={() => void handleCreate()}
        >
          {busy ? "Sealing…" : "Seal & share"}
        </Button>
      </div>
      {client === undefined && (
        <p className="nt-share__hint">Rendering needs the app client — open this dialog in the app.</p>
      )}
      {done && (
        <p className="nt-share__hint">
          Sealed. Share the password out of band (chat, in person) — anyone with the password and the
          account reads the page from their Shares hub.
        </p>
      )}
      {error !== null && <p className="nt-error">{error}</p>}
    </section>
  );
}
