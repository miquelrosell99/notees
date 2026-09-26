/**
 * App — slice 1 shell. Bootstrap screen (server URL + API key + workspace id,
 * remembered in localStorage), then a page-list sidebar + selected PageView
 * over a WorkspaceClient synced through an HttpTransport.
 */

import { useEffect, useState, type FormEvent } from "react";

import { deriveDisplayName } from "@notees/domain";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import { WorkspaceClient } from "@/core/workspace-client.js";

import { PageView } from "./PageView.js";
import "./app.css";

const STORAGE_KEYS = {
  serverUrl: "notees.serverUrl",
  apiKey: "notees.apiKey",
  workspaceId: "notees.workspaceId",
} as const;

type ConnStatus = "config" | "connecting" | "ready" | "error";

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function App() {
  const [serverUrl, setServerUrl] = useState(() => readStored(STORAGE_KEYS.serverUrl));
  const [apiKey, setApiKey] = useState(() => readStored(STORAGE_KEYS.apiKey));
  const [workspaceId, setWorkspaceId] = useState(() => readStored(STORAGE_KEYS.workspaceId));
  const [status, setStatus] = useState<ConnStatus>("config");
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<WorkspaceClient | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [, setPagesVersion] = useState(0);

  useEffect(() => {
    if (client === null) return;
    return client.subscribe(() => setPagesVersion((v) => v + 1));
  }, [client]);

  useEffect(() => {
    return () => {
      client?.close();
    };
  }, [client]);

  async function handleConnect(event: FormEvent) {
    event.preventDefault();
    setStatus("connecting");
    setError(null);
    try {
      localStorage.setItem(STORAGE_KEYS.serverUrl, serverUrl);
      localStorage.setItem(STORAGE_KEYS.apiKey, apiKey);
      localStorage.setItem(STORAGE_KEYS.workspaceId, workspaceId);
      const nextClient = await WorkspaceClient.createHttp({
        serverUrl,
        apiKey,
        workspaceId,
        sqlJsConfig: { locateFile: () => sqlWasmUrl },
      });
      await nextClient.bootstrapWorkspace(workspaceId);
      setClient(nextClient);
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleNewPage() {
    if (client === null) return;
    const id = await client.createObject({ nodeType: "page", name: "Untitled" });
    setSelectedPageId(id);
  }

  if (status !== "ready" || client === null) {
    return (
      <div className="nt-bootstrap">
        <form className="nt-bootstrap-form" onSubmit={(e) => void handleConnect(e)}>
          <h1 className="nt-bootstrap-title">Notees</h1>
          <label className="nt-field">
            <span>Server URL</span>
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://notees.example.com"
              required
            />
          </label>
          <label className="nt-field">
            <span>API key</span>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="relay API key"
              type="password"
              required
            />
          </label>
          <label className="nt-field">
            <span>Workspace ID</span>
            <input
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="workspace UUID"
              required
            />
          </label>
          <button type="submit" disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting…" : "Connect"}
          </button>
          {status === "error" && <p className="nt-error">Connection failed: {error}</p>}
        </form>
      </div>
    );
  }

  const pages = client.listPages();

  return (
    <div className="nt-app">
      <aside className="nt-sidebar">
        <div className="nt-sidebar-header">
          <span>Pages</span>
          <button type="button" className="nt-new-page" onClick={() => void handleNewPage()}>
            + New page
          </button>
        </div>
        <ul className="nt-page-list">
          {pages.map((page) => (
            <li key={page.id}>
              <button
                type="button"
                className={page.id === selectedPageId ? "nt-page-item nt-page-item-active" : "nt-page-item"}
                onClick={() => setSelectedPageId(page.id)}
              >
                {deriveDisplayName(page) || page.id}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="nt-main">
        {selectedPageId !== null ? (
          <PageView client={client} pageId={selectedPageId} />
        ) : (
          <div className="nt-empty">Select a page.</div>
        )}
      </main>
    </div>
  );
}
