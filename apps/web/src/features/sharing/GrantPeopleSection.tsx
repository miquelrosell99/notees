/**
 * GrantPeopleSection — the Share modal's people half (per-node grants,
 * trusted-circle v1): grant a workspace member read or EDIT access to this
 * node's whole subtree. An email that matches no account yet rides as a
 * PENDING grant — it starts working the moment someone registers with that
 * email (no invite tokens). The grantee needs a membership on the workspace
 * (the owner sets role "member" = restricted, write-guarded to her edit
 * closures); the honest one-liner says so.
 *
 * Read is the default role (public links stay read-only by design; people
 * grants start the same way and escalate explicitly).
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/kit/Button.js";
import { InlineConfirmButton } from "../../components/ui/kit/InlineConfirmButton.js";
import { createGrant, listNodeGrants, revokeGrant, type GrantEntry } from "./shareApi.js";

export function GrantPeopleSection({
  serverUrl,
  token,
  nodeUuid,
}: {
  serverUrl: string;
  token: string;
  nodeUuid: string;
}) {
  const [grants, setGrants] = useState<GrantEntry[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"read" | "edit">("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { grants: list } = await listNodeGrants(serverUrl, token, nodeUuid);
    setGrants(list);
  }, [serverUrl, token, nodeUuid]);

  useEffect(() => {
    let cancelled = false;
    refresh().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function handleAdd() {
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await createGrant(serverUrl, token, { nodeId: nodeUuid, granteeEmail: trimmed, role });
      setEmail("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(grantId: string) {
    setError(null);
    try {
      await revokeGrant(serverUrl, token, grantId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="nt-share__people" aria-label="People with access">
      <h3 className="nt-share__people-title">People with access</h3>
      <p className="nt-share__hint">
        Grant a workspace member this page and everything under it. They need an account on this
        server; an unknown email waits until someone registers with it.
      </p>
      <div className="nt-share__people-form">
        <input
          type="email"
          className="nt-share__people-input"
          placeholder="person@example.com"
          aria-label="Grantee email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleAdd();
          }}
        />
        <select
          className="nt-share__people-role"
          aria-label="Grant role"
          value={role}
          onChange={(event) => setRole(event.target.value as "read" | "edit")}
        >
          <option value="read">Can read</option>
          <option value="edit">Can edit</option>
        </select>
        <Button variant="outline" size="sm" disabled={busy || email.trim().length === 0} onClick={() => void handleAdd()}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
      {grants !== null && grants.length > 0 && (
        <ul className="nt-share__list">
          {grants.map((grant) => (
            <li key={grant.id} className="nt-share__row">
              <span className="nt-share__meta">{grant.granteeEmail ?? grant.granteeUserId}</span>
              <span className="nt-share__grant-role">{grant.role === "edit" ? "Can edit" : "Can read"}</span>
              <span className="nt-share__actions">
                <InlineConfirmButton
                  variant="danger"
                  size="sm"
                  title="Revoke this grant"
                  confirmTitle="Revoke now — they lose access on every surface immediately"
                  cancelTitle="Keep the grant"
                  onConfirm={() => handleRevoke(grant.id)}
                >
                  Revoke
                </InlineConfirmButton>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error !== null && <p className="nt-error">{error}</p>}
    </section>
  );
}
