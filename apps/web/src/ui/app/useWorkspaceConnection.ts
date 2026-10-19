/**
 * useWorkspaceConnection — the React half of the boot/connect flow.
 *
 * Owns the connection-shaped state (client, offline, storeMode,
 * storeReason, sessionSignedIn, workspaceName) plus the boot phase/error
 * state, the live clientRef (the single owner for teardown), the connect
 * wrapper around the framework-free core (store-connection.ts), and the
 * StrictMode-safe unmount close. Realtime acceleration starts after the
 * ready phase flips — best-effort, exactly like the original inline
 * connect: sync already works without it.
 */

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import type { AccountUser } from "@/core/auth-api.js";
import { inProcessReason, type StoreMode } from "./storeMode.js";
import type { AnyClient } from "./clients.js";
import { openStoreConnection, type ConnectOptions } from "./store-connection.js";

export type Phase =
  | { name: "server" }
  | { name: "setup" }
  | { name: "login" }
  | { name: "signup" }
  | { name: "workspaces"; user: AccountUser }
  | { name: "connecting"; label: string }
  | { name: "ready" };

export interface WorkspaceConnection {
  client: AnyClient | null;
  /** The single owner of the live client for imperative reads + teardown. */
  clientRef: RefObject<AnyClient | null>;
  offline: boolean;
  storeMode: StoreMode;
  storeReason: string | undefined;
  /** True when the live credential is a session (API-key management needs one). */
  sessionSignedIn: boolean;
  setSessionSignedIn: Dispatch<SetStateAction<boolean>>;
  workspaceName: string;
  setWorkspaceName: Dispatch<SetStateAction<string>>;
  phase: Phase;
  setPhase: Dispatch<SetStateAction<Phase>>;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  connect: (
    url: string,
    credential: string,
    workspaceId: string,
    options: ConnectOptions,
  ) => Promise<void>;
  /** Close the live client and clear it from state (sign-out / forget / switch-server). */
  closeClient: () => void;
}

export function useWorkspaceConnection(): WorkspaceConnection {
  const [client, setClient] = useState<AnyClient | null>(null);
  /**
   * The single owner of the live client for teardown. State (`client`)
   * drives rendering; the ref lets the unmount-only effect below close
   * exactly the client that is live at unmount time.
   */
  const clientRef = useRef<AnyClient | null>(null);
  const [offline, setOffline] = useState(false);
  const [storeMode, setStoreMode] = useState<StoreMode>("in-process");
  const [storeReason, setStoreReason] = useState<string | undefined>(undefined);
  const [sessionSignedIn, setSessionSignedIn] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "server" });
  const [error, setError] = useState<string | null>(null);

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

  async function connect(
    url: string,
    credential: string,
    workspaceId: string,
    options: ConnectOptions,
  ): Promise<void> {
    setPhase({ name: "connecting", label: options.isOffline ? "Opening local workspace…" : "Connecting…" });
    setError(null);
    const previous = clientRef.current;
    clientRef.current = null;
    previous?.close();
    setClient(null);
    try {
      const outcome = await openStoreConnection(url, credential, workspaceId, options);
      clientRef.current = outcome.client;
      setClient(outcome.client);
      setOffline(options.isOffline);
      setStoreMode(outcome.mode);
      setStoreReason(outcome.mode === "in-process" ? inProcessReason() : undefined);
      setSessionSignedIn(outcome.sessionSignedIn);
      setWorkspaceName(outcome.workspaceName);
      setPhase({ name: "ready" });
      // Realtime acceleration is best-effort: sync already works without it.
      try {
        await outcome.client.startRealtime();
      } catch {
        // No WS available/reachable — HTTP catch-up keeps working.
      }
    } catch (err) {
      setPhase({ name: "server" });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function closeClient(): void {
    const live = clientRef.current;
    clientRef.current = null;
    live?.close();
    setClient(null);
  }

  return {
    client,
    clientRef,
    offline,
    storeMode,
    storeReason,
    sessionSignedIn,
    setSessionSignedIn,
    workspaceName,
    setWorkspaceName,
    phase,
    setPhase,
    error,
    setError,
    connect,
    closeClient,
  };
}
