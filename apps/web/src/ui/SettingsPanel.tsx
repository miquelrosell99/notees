/**
 * SettingsPanel — account settings modal. Currently hosts the API-keys
 * manager: per-user machine credentials minted on the sync server (routes-auth
 * /api-keys), shown once at creation with a copy action, revocable here.
 * Session-only: an API key cannot mint more keys.
 */

import { useEffect, useState, type FormEvent } from "react";

import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type AccountUser,
  type ApiKeyEntry,
} from "@/core/auth-api.js";

import "./components/Modal.css";

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
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
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

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const { token: fullToken } = await createApiKey(serverUrl, token, newName.trim());
      setFreshKey({ name: newName.trim(), token: fullToken });
      setNewName("");
      const { apiKeys } = await listApiKeys(serverUrl, token);
      setKeys(apiKeys);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    <div className="nt-modal-backdrop" onClick={onClose}>
      <div
        className="nt-modal nt-settings"
        role="dialog"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="nt-modal-header">
          <h2 className="nt-modal-title">Settings</h2>
          <button type="button" className="nt-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="nt-settings-account">
          Signed in as <strong>{user.email}</strong>
          {user.isAdmin ? " (admin)" : ""}
        </p>

        <section className="nt-settings-section">
          <h3 className="nt-settings-heading">API keys</h3>
          <p className="nt-settings-hint">
            API keys let other clients (the CLI, GTK, Flutter) sign in as you without your
            password. A key is shown once at creation — store it somewhere safe.
          </p>
          <ul className="nt-apikey-list">
            {keys.map((key) => (
              <li key={key.id} className={key.revokedAt !== null ? "nt-apikey nt-apikey-revoked" : "nt-apikey"}>
                <span className="nt-apikey-name">{key.name}</span>
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
            <button type="submit" disabled={newName.trim() === ""}>
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
        </section>

        {error !== null && <p className="nt-error">{error}</p>}
      </div>
    </div>
  );
}
