import { useState, type FormEvent } from "react";
import type { Connection } from "./connection";

export function SettingsPanel({ connection }: { connection: Connection }) {
  const [port, setPort] = useState(String(connection.settings.port));
  const [token, setToken] = useState(connection.settings.token);
  const busy = connection.connection === "connecting";

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    void connection.connect(Number(port), token.trim());
  }

  return (
    <section className="settings-panel" aria-label="Bridge connection settings">
      <p className="settings-hint">
        Connect to the <code>notees serve</code> bridge on this machine.
      </p>
      <form className="settings-form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            step={1}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={busy}
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Pairing token</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
            placeholder="from notees serve output"
            autoComplete="off"
          />
        </label>
        {connection.connection === "offline" && (
          <p className="form-error" role="alert">
            Bridge offline — is <code>notees serve</code> running?
          </p>
        )}
        {connection.connection === "rejected" && (
          <p className="form-error" role="alert">
            Pairing token rejected — check <code>notees serve</code> output.
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </section>
  );
}
