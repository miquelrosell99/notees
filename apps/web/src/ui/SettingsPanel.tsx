/**
 * SettingsPanel — account settings modal. Currently hosts the API-keys
 * manager: per-user machine credentials minted on the sync server (routes-auth
 * /api-keys), shown once at creation with a copy action, revocable here.
 * Session-only: an API key cannot mint more keys.
 *
 * ApiKeysSection is the embeddable inner content (no backdrop); the
 * recovered user settings modal mounts it as its Account-tab API-keys
 * section, and SettingsPanel wraps it in modal chrome for standalone use.
 */

import { useEffect, useState, type FormEvent } from "react";

import {
  API_SCOPES,
  createApiKey,
  installApiKeyCustody,
  listApiKeys,
  revokeApiKey,
  unlock,
  type AccountUser,
  type ApiKeyEntry,
} from "@/core/auth-api.js";
import { buildMachineCustodyRecord } from "@/core/machine-key.js";
import { importMasterKey, unwrapMasterKeyWithBytes } from "@notees/protocol";

import { Modal } from "../components/ui/kit/Modal.js";

export function ApiKeysSection({ serverUrl, token, email }: { serverUrl: string; token: string; email: string }) {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  /** Empty = full access (the key is created without a scope list). */
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  /**
   * Every key carries custody: the wrap is installed at mint, sealed with
   * `sealPassword` (the master for the wrap is re-derived from it at that
   * moment — the session's working master is non-extractable by design; the
   * unlock oracle checks the password, the wrap never leaves the device
   * except as the opaque record). Keys minted before custody existed keep
   * working password-gated.
   */
  const [sealPassword, setSealPassword] = useState("");
  const [freshKey, setFreshKey] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listApiKeys(serverUrl, token)
      .then((result) => {
        if (!cancelled) setKeys(result.apiKeys);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, token]);

  async function refreshKeys(): Promise<void> {
    const { apiKeys } = await listApiKeys(serverUrl, token);
    setKeys(apiKeys);
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const name = newName.trim();
    try {
      const { apiKey, token: fullToken } = await createApiKey(serverUrl, token, name, {
        scopes: selectedScopes.length > 0 ? selectedScopes : undefined,
      });
      try {
        const { kdf } = await unlock(serverUrl, { email, password: sealPassword });
        const { bytes } = await unwrapMasterKeyWithBytes(sealPassword, kdf);
        // Extractable re-import: the wrap exports the master (the session
        // working key is non-extractable by design — the recovery-code and
        // change-password pattern).
        const master = await importMasterKey(bytes, true);
        const record = await buildMachineCustodyRecord(master, fullToken);
        await installApiKeyCustody(serverUrl, token, apiKey.id, record);
      } catch (custodyError) {
        // The key EXISTS but carries no custody — say so plainly, never pretend.
        throw new Error(
          "key created WITHOUT custody (" +
            (custodyError instanceof Error ? custodyError.message : String(custodyError)) +
            ") — it will need your password on encrypted workspaces; revoke it and retry",
        );
      }
      setFreshKey({ name, token: fullToken });
      setNewName("");
      setSelectedScopes([]);
      setSealPassword("");
      await refreshKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A mint may have landed before the failure — keep the list honest.
      await refreshKeys().catch(() => undefined);
    }
  }

  async function handleRevoke(id: string) {
    setError(null);
    try {
      await revokeApiKey(serverUrl, token, id);
      setRevokeConfirm(null);
      const { apiKeys } = await listApiKeys(serverUrl, token);
      setKeys(apiKeys);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCopy() {
    if (freshKey === null) return;
    try {
      await navigator.clipboard.writeText(freshKey.token);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context): the user selects manually.
    }
  }

  return (
    <section className="nt-settings-section">
      <h3 className="nt-settings-heading">API keys</h3>
      <p className="nt-settings-hint">
        API keys let other clients (the CLI, GTK, Flutter) sign in as you. A key is
        shown once at creation — store it somewhere safe. Every key opens your
        workspaces by itself (your password seals the key at creation; it is checked
        like an unlock and never leaves the device). Scopes restrict what a key may
        touch. Keys minted before custody existed are flagged — they need your
        password on encrypted workspaces.
      </p>
      <ul className="nt-apikey-list">
        {keys
          // Revoked keys are history, not inventory — the list shows the live set.
          .filter((key) => key.revokedAt === null)
          .map((key) => (
          <li key={key.id} className="nt-apikey">
            <span className="nt-apikey-name">{key.name}</span>
            <span className="nt-apikey-badges">
              {!key.machine && <span className="nt-apikey-badge nt-apikey-badge-machine">password-gated (legacy)</span>}
              {key.scopes === null ? (
                <span className="nt-apikey-badge">full access</span>
              ) : (
                key.scopes.map((scope) => (
                  <span key={scope} className="nt-apikey-badge">
                    {API_SCOPES.find((known) => known.id === scope)?.label ?? scope}
                  </span>
                ))
              )}
            </span>
            <code className="nt-apikey-prefix">{key.prefix}…</code>
            <span className="nt-apikey-meta">
              {key.lastUsedAt !== null ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "never used"}
            </span>
            {revokeConfirm === key.id ? (
              <span className="nt-apikey-revoke-confirm">
                Revoke?
                <button type="button" onClick={() => void handleRevoke(key.id)}>
                  Yes
                </button>
                <button type="button" onClick={() => setRevokeConfirm(null)}>
                  No
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="nt-apikey-revoke"
                onClick={() => setRevokeConfirm(key.id)}
              >
                Revoke
              </button>
            )}
          </li>
        ))}
        {keys.every((key) => key.revokedAt !== null) && <li className="nt-apikey-empty">No API keys yet.</li>}
      </ul>
      <form className="nt-apikey-new" onSubmit={(e) => void handleCreate(e)}>
        <div className="nt-apikey-fields">
          <label className="nt-apikey-field">
            <span>Name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Key name (e.g. laptop CLI)"
              required
            />
          </label>
          <label className="nt-apikey-field">
            <span>Your password</span>
            <input
              type="password"
              value={sealPassword}
              onChange={(e) => setSealPassword(e.target.value)}
              placeholder="Seals the key — checked like an unlock"
              autoComplete="off"
              required
            />
          </label>
        </div>
        <fieldset className="nt-apikey-access">
          <legend>Permissions</legend>
          <table className="nt-apikey-acl">
            <thead>
              <tr>
                <th scope="col">Permission</th>
                <th scope="col">Allow</th>
              </tr>
            </thead>
            <tbody>
              {API_SCOPES.map((scope) => (
                <tr key={scope.id}>
                  <td>{scope.label}</td>
                  <td className="nt-apikey-acl-check">
                    <input
                      type="checkbox"
                      aria-label={scope.label}
                      checked={selectedScopes.includes(scope.id)}
                      onChange={() =>
                        setSelectedScopes((current) =>
                          current.includes(scope.id)
                            ? current.filter((entry) => entry !== scope.id)
                            : [...current, scope.id],
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="nt-apikey-seal-note">
            All unchecked = full access. Every key opens your workspaces by itself —
            including encrypted ones; the seal is built on this device and the password is
            never stored. Possession of a key is possession of what its checked permissions
            allow.
          </p>
        </fieldset>
        <button type="submit" disabled={newName.trim() === "" || sealPassword === ""}>
          Create key
        </button>
      </form>
      {freshKey !== null && (
        <div className="nt-apikey-fresh">
          <p>
            Key <strong>{freshKey.name}</strong> created — copy it now, it will not be shown
            again:
          </p>
          <code className="nt-apikey-token">{freshKey.token}</code>
          <div className="nt-apikey-fresh-actions">
            <button type="button" onClick={() => void handleCopy()}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button type="button" onClick={() => { setFreshKey(null); setCopied(false); }}>
              Done
            </button>
          </div>
        </div>
      )}

      {error !== null && <p className="nt-error">{error}</p>}
    </section>
  );
}

export function SettingsPanel({
  serverUrl,
  token,
  user,
  onClose,
}: {
  serverUrl: string;
  token: string;
  user: AccountUser;
  onClose: () => void;
}) {
  return (
    <Modal isOpen onClose={onClose} title="Settings" size="md" className="nt-settings">
      <p className="nt-settings-account">
        Signed in as <strong>{user.email}</strong>
        {user.isAdmin ? " (admin)" : ""}
      </p>
      <ApiKeysSection serverUrl={serverUrl} token={token} email={user.email ?? ""} />
    </Modal>
  );
}
