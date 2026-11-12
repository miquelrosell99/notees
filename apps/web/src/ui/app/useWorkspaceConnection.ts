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
import {
  AdoptionOfferError,
  EncryptedWorkspaceLockedError,
  openStoreConnection,
  type ConnectOptions,
} from "./store-connection.js";

export type Phase =
  | { name: "server" }
  | { name: "setup" }
  | { name: "login" }
  | { name: "signup" }
  | { name: "workspaces"; user: AccountUser }
  | { name: "connecting"; label: string }
  | { name: "ready" };

/**
 * A refused open: the workspace is encrypted and this session holds no
 * master key. The App renders the unlock re-prompt for it; on success it
 * re-invokes connect (with the re-derived key), on cancel it returns to the
 * workspace selector.
 */
export interface UnlockRequest {
  url: string;
  credential: string;
  workspaceId: string;
  name: string;
  credentialType: "session" | "apikey";
}

/**
 * A paused open (F2): an offline-created workspace opened online against a
 * server that has never seen it, with content in the local store. The App
 * renders the adoption offer; publishing confirms (`confirmWorkspaceAdoption`
 * + reconnect), keeping it local re-opens with `declinedAdoption` (plaintext,
 * zero writes).
 */
export interface AdoptionRequest {
  url: string;
  credential: string;
  workspaceId: string;
  name: string;
  credentialType: "session" | "apikey";
}

export interface WorkspaceConnection {
  client: AnyClient | null;
  /** The single owner of the live client for imperative reads + teardown. */
  clientRef: RefObject<AnyClient | null>;
  offline: boolean;
  storeMode: StoreMode;
  storeReason: string | undefined;
  /** Non-null while a refused encrypted open waits for the unlock re-prompt. */
  unlockRequest: UnlockRequest | null;
  setUnlockRequest: Dispatch<SetStateAction<UnlockRequest | null>>;
  /** Non-null while an offline-created open waits on the adoption offer (F2). */
  adoptionRequest: AdoptionRequest | null;
  setAdoptionRequest: Dispatch<SetStateAction<AdoptionRequest | null>>;
  /**
   * The engine's current sync-phase message during connect ("Fetching latest
   * snapshot…", "Catching up… N operations") — the connecting screen's
   * progress line. Null when not connecting.
   */
  connectProgress: string | null;
  /** Catch-up fraction 0–1 for the connecting screen's progress bar, or null before the first payload / after the phase leaves catching-up. */
  connectProgressFraction: number | null;
  /** True when the live credential is a session (API-key management needs one). */
  sessionSignedIn: boolean;
  setSessionSignedIn: Dispatch<SetStateAction<boolean>>;
  workspaceName: string;
  setWorkspaceName: Dispatch<SetStateAction<string>>;
  /**
   * Positive knowledge that the open workspace carries no wrapped key (from
   * the connect's key resolution) — the not-encrypted banner's gate. Cleared
   * on close; false means keyed, offline, or indeterminate (no banner).
   */
  workspacePlaintext: boolean;
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
  const [unlockRequest, setUnlockRequest] = useState<UnlockRequest | null>(null);
  const [adoptionRequest, setAdoptionRequest] = useState<AdoptionRequest | null>(null);
  const [connectProgress, setConnectProgress] = useState<string | null>(null);
  const [connectProgressFraction, setConnectProgressFraction] = useState<number | null>(null);
  const [storeReason, setStoreReason] = useState<string | undefined>(undefined);
  const [sessionSignedIn, setSessionSignedIn] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspacePlaintext, setWorkspacePlaintext] = useState(false);
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
    setConnectProgress(null);
    setConnectProgressFraction(null);
    setWorkspacePlaintext(false);
    const previous = clientRef.current;
    clientRef.current = null;
    previous?.close();
    setClient(null);
    try {
      const outcome = await openStoreConnection(url, credential, workspaceId, {
        ...options,
        onSyncPhase: (phase, message) => {
          setConnectProgress(message);
          // Progress payloads only ride the catching-up phase; leaving it
          // (synced/error) clears the bar back to the phase text.
          if (phase !== "catching-up") setConnectProgressFraction(null);
        },
        onSyncProgress: (applied, total) => {
          setConnectProgressFraction(total > 0 ? Math.min(1, Math.max(0, applied / total)) : null);
        },
      });
      setUnlockRequest(null);
      setAdoptionRequest(null);
      clientRef.current = outcome.client;
      setClient(outcome.client);
      setConnectProgress(null);
      setConnectProgressFraction(null);
      setOffline(options.isOffline);
      setStoreMode(outcome.mode);
      setStoreReason(outcome.mode === "in-process" ? inProcessReason() : undefined);
      setSessionSignedIn(outcome.sessionSignedIn);
      setWorkspaceName(outcome.workspaceName);
      setWorkspacePlaintext(outcome.workspacePlaintext);
      setPhase({ name: "ready" });
      // Realtime acceleration is best-effort: sync already works without it.
      try {
        await outcome.client.startRealtime();
      } catch {
        // No WS available/reachable — HTTP catch-up keeps working.
      }
    } catch (err) {
      setConnectProgress(null);
      setConnectProgressFraction(null);
      if (err instanceof EncryptedWorkspaceLockedError) {
        // Fail loud, never keyless: the open refused before any client was
        // created. The unlock re-prompt takes over; cancel returns to the
        // selector (the App applies the phase change — it owns the account).
        setUnlockRequest({
          url,
          credential,
          workspaceId,
          name: options.label ?? "Workspace",
          credentialType: options.credentialType,
        });
        return;
      }
      if (err instanceof AdoptionOfferError) {
        // The open paused before any client was created: an offline-created
        // workspace with local content meets a server that has never seen it.
        // The App renders the adoption offer over the connecting screen;
        // confirm reconnects (the create publishes the wrap), decline
        // re-opens with declinedAdoption (plaintext, zero writes).
        setAdoptionRequest({
          url: err.url,
          credential: err.credential,
          workspaceId: err.workspaceId,
          name: err.workspaceName,
          credentialType: err.credentialType,
        });
        return;
      }
      setPhase({ name: "server" });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function closeClient(): void {
    const live = clientRef.current;
    clientRef.current = null;
    live?.close();
    setClient(null);
    setWorkspacePlaintext(false);
  }

  return {
    client,
    clientRef,
    offline,
    storeMode,
    storeReason,
    unlockRequest,
    setUnlockRequest,
    adoptionRequest,
    setAdoptionRequest,
    connectProgress,
    connectProgressFraction,
    sessionSignedIn,
    setSessionSignedIn,
    workspaceName,
    setWorkspaceName,
    workspacePlaintext,
    phase,
    setPhase,
    error,
    setError,
    connect,
    closeClient,
  };
}
