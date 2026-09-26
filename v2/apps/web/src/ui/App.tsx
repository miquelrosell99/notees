/**
 * App — slice 1 shell + slice 2 browser persistence + slice 3 realtime sync.
 * Bootstrap screen (server URL + API key + workspace id; the URL may be
 * prefilled by /config.js and is remembered in localStorage), then a
 * page-list sidebar + selected PageView over a WorkspaceClient synced through
 * an HttpTransport. The client runs in a Web Worker with the SQLite image
 * persisted to OPFS when the browser supports it (Worker +
 * navigator.storage.getDirectory), else in-process. After connect the WS
 * acceleration path is wired (startRealtime) and the footer polls the
 * worker's sync status.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";

import { deriveDisplayName } from "@notees/domain";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import { WorkspaceClient, type SyncStatusSnapshot } from "@/core/workspace-client.js";
import { WorkerClient } from "@/core/worker-client.js";

import { PageView } from "./PageView.js";
import "./app.css";

const STORAGE_KEYS = {
  serverUrl: "notees.serverUrl",
  apiKey: "notees.apiKey",
  workspaceId: "notees.workspaceId",
} as const;

/** Footer status before the first status() snapshot arrives. */
const INITIAL_SYNC_STATUS: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

/** Poll cadence for the sync status snapshot while mounted. */
const STATUS_POLL_MS = 2_000;

type ConnStatus = "config" | "connecting" | "ready" | "error";
type StoreMode = "worker" | "in-process";
type AnyClient = WorkspaceClient | WorkerClient;

function detectStoreMode(): StoreMode {
  return typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.storage?.getDirectory !== undefined
    ? "worker"
    : "in-process";
}

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Footer sync line: engine state, undelivered backlog, realtime indicator. */
function SyncStatusLine({ snapshot }: { snapshot: SyncStatusSnapshot }) {
  const backlog = snapshot.pending + snapshot.failed;
  const label =
    snapshot.status === "idle"
      ? `Sync: idle · ${backlog} pending`
      : snapshot.status === "syncing"
        ? `Sync: syncing… · ${backlog} pending`
        : `Sync error${snapshot.error ? `: ${snapshot.error}` : ""} · ${backlog} pending`;
  return (
    <span
      className={
        snapshot.status === "error" ? "nt-sync-status nt-sync-status-error" : "nt-sync-status"
      }
      title={snapshot.error ?? undefined}
    >
      {label}
      {snapshot.realtime ? "" : " · realtime off"}
    </span>
  );
}

/**
 * Initial server URL: a remembered value (localStorage) wins; otherwise the
 * /config.js runtime prefill (window.NOTEES_CONFIG, written by the web
 * container entrypoint from NOTEES_SERVER_URL) defaults the form field.
 * Empty result → the user types it manually.
 */
function initialServerUrl(): string {
  return readStored(STORAGE_KEYS.serverUrl) || window.NOTEES_CONFIG?.serverUrl || "";
}

export function App() {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [apiKey, setApiKey] = useState(() => readStored(STORAGE_KEYS.apiKey));
  const [workspaceId, setWorkspaceId] = useState(() => readStored(STORAGE_KEYS.workspaceId));
  const [status, setStatus] = useState<ConnStatus>("config");
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<AnyClient | null>(null);
  const [storeMode, setStoreMode] = useState<StoreMode>("in-process");
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot>(INITIAL_SYNC_STATUS);
  const [, setPagesVersion] = useState(0);

  /**
   * The single owner of the live client for teardown. State (`client`) drives
   * rendering; the ref lets the unmount-only effect below close exactly the
   * client that is live at unmount time.
   */
  const clientRef = useRef<AnyClient | null>(null);

  useEffect(() => {
    if (client === null) return;
    return client.subscribe(() => setPagesVersion((v) => v + 1));
  }, [client]);

  // Poll the (cheap) status snapshot on a cadence and on every worker
  // notification; both fire React state only when the client changes.
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const snapshot = await client.status();
        if (!cancelled) setSyncStatus(snapshot);
      } catch {
        // Client closed mid-poll; the effect teardown disposes the interval.
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), STATUS_POLL_MS);
    const unsubscribe = client.subscribe(() => void refresh());
    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubscribe();
    };
  }, [client]);

  // StrictMode-safe teardown: empty-deps cleanup runs on real unmount only,
  // and the identity check guarantees a dev double-invoked cleanup (or a
  // connect-swap below) never closes a client something else still owns.
  useEffect(() => {
    return () => {
      const live = clientRef.current;
      clientRef.current = null;
      live?.close();
    };
  }, []);

  async function handleConnect(event: FormEvent) {
    event.preventDefault();
    setStatus("connecting");
    setError(null);
    // A previous session's client (if any) is replaced: close it now rather
    // than in an effect cleanup, so reconnects never tear down the new one.
    const previous = clientRef.current;
    clientRef.current = null;
    previous?.close();
    setClient(null);
    try {
      localStorage.setItem(STORAGE_KEYS.serverUrl, serverUrl);
      localStorage.setItem(STORAGE_KEYS.apiKey, apiKey);
      localStorage.setItem(STORAGE_KEYS.workspaceId, workspaceId);
      const mode = detectStoreMode();
      const nextClient: AnyClient =
        mode === "worker"
          ? await WorkerClient.create({ serverUrl, apiKey, workspaceId, sqlWasmUrl })
          : await WorkspaceClient.createHttp({
              serverUrl,
              apiKey,
              workspaceId,
              sqlJsConfig: { locateFile: () => sqlWasmUrl },
            });
      // The worker path bootstraps during init; the in-process path syncs here.
      if (mode === "in-process") await nextClient.bootstrapWorkspace(workspaceId);
      clientRef.current = nextClient;
      setClient(nextClient);
      setStoreMode(mode);
      setStatus("ready");
      // Realtime acceleration is best-effort: sync already works without it.
      try {
        await nextClient.startRealtime();
      } catch {
        // No WS available/reachable — HTTP catch-up keeps working.
      }
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
          <PageView client={client} pageId={selectedPageId} onOpenPage={setSelectedPageId} />
        ) : (
          <div className="nt-empty">Select a page.</div>
        )}
      </main>
      <footer className="nt-footer">
        <span className="nt-footer-store">
          {storeMode === "worker"
            ? "Local store: Web Worker + OPFS (persisted on this device)"
            : "Local store: in-process (Worker/OPFS unavailable in this browser)"}
        </span>
        <SyncStatusLine snapshot={syncStatus} />
      </footer>
    </div>
  );
}
