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
   * Machine key: custody wrap installed at mint. The master for the wrap is
   * re-derived from `machinePassword` at that moment (the session's working
   * master is non-extractable by design) — the unlock oracle checks the
   * password, the wrap never leaves the device except as the opaque record.
   */
  const [machineWanted, setMachineWanted] = useState(false);
  const [machinePassword, setMachinePassword] = useState("");
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
        if (machineWanted) {
          const { kdf } = await unlock(serverUrl, { email, password: machinePassword });
          const { bytes } = await unwrapMasterKeyWithBytes(machinePassword, kdf);
          // Extractable re-import: the wrap exports the master (the session
          // working key is non-extractable by design — the recovery-code and
          // change-password pattern).
          const master = await importMasterKey(bytes, true);
          const record = await buildMachineCustodyRecord(master, fullToken);
          await installApiKeyCustody(serverUrl, token, apiKey.id, record);
        }
      } catch (custodyError) {
        // The key EXISTS but is human — say so plainly, never pretend.
        throw new Error(
          "key created WITHOUT custody (" +
            (custodyError instanceof Error ? custodyError.message : String(custodyError)) +
            ") — it is not a machine key; revoke it and retry",
        );
      }
      setFreshKey({ name, token: fullToken });
      setNewName("");
      setSelectedScopes([]);
      setMachineWanted(false);
      setMachinePassword("");
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
        API keys let other clients (the CLI, GTK, Flutter) sign in as you without your
        password. A key is shown once at creation — store it somewhere safe. Scopes
        restrict what a key may touch; a machine key also carries custody and opens
        encrypted workspaces alone.
      </p>
      <ul className="nt-apikey-list">
        {keys.map((key) => (
          <li key={key.id} className={key.revokedAt !== null ? "nt-apikey nt-apikey-revoked" : "nt-apikey"}>
            <span className="nt-apikey-name">{key.name}</span>
            <span className="nt-apikey-badges">
              {key.machine && <span className="nt-apikey-badge nt-apikey-badge-machine">machine</span>}
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
              {key.revokedAt !== null
                ? "revoked"
                : key.lastUsedAt !== null
                  ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                  : "never used"}
            </span>
            {key.revokedAt === null &&
              (revokeConfirm === key.id ? (
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
              ))}
          </li>
        ))}
        {keys.length === 0 && <li className="nt-apikey-empty">No API keys yet.</li>}
      </ul>
      <form className="nt-apikey-new" onSubmit={(e) => void handleCreate(e)}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Key name (e.g. laptop CLI)"
          required
        />
        <fieldset className="nt-apikey-access">
          <legend>Access</legend>
          <div className="nt-apikey-scopes">
            {API_SCOPES.map((scope) => (
              <button
                key={scope.id}
                type="button"
                aria-pressed={selectedScopes.includes(scope.id)}
                className={
                  selectedScopes.includes(scope.id) ? "nt-scope-chip nt-scope-chip-on" : "nt-scope-chip"
                }
                onClick={() =>
                  setSelectedScopes((current) =>
                    current.includes(scope.id)
                      ? current.filter((entry) => entry !== scope.id)
                      : [...current, scope.id],
                  )
                }
              >
                {scope.label}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="nt-apikey-machine">
          <input
            type="checkbox"
            checked={machineWanted}
            onChange={(e) => setMachineWanted(e.target.checked)}
          />
          <span>
            Machine key — opens encrypted workspaces without a password. Possession of this
            key is possession of the content.
          </span>
        </label>
        {machineWanted && (
          <input
            type="password"
            value={machinePassword}
            onChange={(e) => setMachinePassword(e.target.value)}
            placeholder="Your password (seals the key — checked like an unlock, wrap stays on this device)"
            autoComplete="off"
            required
          />
        )}
        <button type="submit" disabled={newName.trim() === "" || (machineWanted && machinePassword === "")}>
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
