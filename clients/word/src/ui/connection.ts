import { useCallback, useEffect, useRef, useState } from "react";
import type { Bridge, BridgeError, BridgeResponse } from "../bridge/types";
import { BridgeOfflineError } from "../bridge/client";
import type { AddinSettings, SettingsStore } from "../settings/store";

export type ConnectionState =
  | "unknown"
  | "connecting"
  | "paired"
  | "offline"
  | "rejected";

export interface CitationStyle {
  id: string;
  label: string;
}

export type BridgeFactory = (port: number, token: string) => Bridge;

export type ProbeOutcome =
  | { state: "paired"; bridge: Bridge; styles: CitationStyle[] }
  | { state: "offline" }
  | { state: "rejected" };

/**
 * Bridge errors that mean the bridge is alive but refused THIS client:
 * wrong or missing pairing token or a failed add-in origin check. Lane C
 * answers both with the generic wire body {ok:false,error:{code:"bad_request"}},
 * so the HTTP status is the authoritative signal; the code set is kept as
 * belt-and-braces for any endpoint that does set a semantic code. Any other
 * ok:false (not_found, unknown_style, …) proves the bridge is reachable and
 * accepted the token — the command simply failed — so it is NOT a rejection.
 */
const REJECTED_CODES = new Set(["unauthorized", "forbidden", "origin_denied"]);

export function isRejectedError(error: BridgeError): boolean {
  return error.status === 401 || error.status === 403 || isRejectedCode(error.code);
}

export function isRejectedCode(code: string): boolean {
  return REJECTED_CODES.has(code);
}

/**
 * Pure state-machine step: given a bridge built for (port, token), classify
 * the listStyles() outcome. Unit-testable with a fake bridge — no Word, no
 * fetch, no localStorage. Thrown errors other than BridgeOfflineError (e.g.
 * a shape error from a misbehaving endpoint) are treated as offline: the
 * bridge is not usable either way.
 */
export async function probeBridge(bridge: Bridge): Promise<ProbeOutcome> {
  try {
    const res = await bridge.listStyles();
    if (!res.ok) {
      if (isRejectedError(res.error)) return { state: "rejected" };
      return { state: "paired", bridge, styles: [] };
    }
    return { state: "paired", bridge, styles: res.styles };
  } catch (e) {
    if (e instanceof BridgeOfflineError) return { state: "offline" };
    // Any other throw (e.g. a shape error from a misbehaving endpoint):
    // the bridge is not usable either way.
    return { state: "offline" };
  }
}

export interface UseConnectionOptions {
  createBridge: BridgeFactory;
  store: SettingsStore;
  /** Attempt connect on mount when a saved token exists (default true). */
  autoConnect?: boolean;
}

export interface Connection {
  connection: ConnectionState;
  settings: AddinSettings;
  bridge: Bridge | null;
  styles: CitationStyle[];
  connect(port: number, token: string): Promise<void>;
  /** Persist the picked citation style — applied to NEW citations only. */
  setStyleId(styleId: string): void;
  /** Re-fetch the style list from the bridge; reconciles the selection. */
  reloadStyles(): Promise<boolean>;
}

/**
 * The picker's selection after a styles reload: keep the current style when
 * the bridge still offers it; fall back to the first listed style; fall back
 * to "apa" (the settings-store default) when the list came back empty.
 */
export function reconcileStyleId(current: string, styles: CitationStyle[]): string {
  if (styles.some((s) => s.id === current)) return current;
  return styles[0]?.id ?? "apa";
}

/**
 * Whether the persisted pick is still offered by the bridge. Restyling
 * rewrites every citation embed to this styleId, so an unknown one (style
 * removed from the styles dir, re-paired workspace) must gate the action off
 * in the pane — and the engine re-checks the same list before rewriting.
 */
export function isKnownStyleId(styleId: string, styles: CitationStyle[]): boolean {
  return styles.some((s) => s.id === styleId);
}

export function useConnection({
  createBridge,
  store,
  autoConnect = true,
}: UseConnectionOptions): Connection {
  const [connection, setConnection] = useState<ConnectionState>("unknown");
  const [settings, setSettings] = useState<AddinSettings>(() => store.load());
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [styles, setStyles] = useState<CitationStyle[]>([]);
  const generation = useRef(0);

  const connect = useCallback(
    async (port: number, token: string) => {
      const mine = ++generation.current;
      const saved = store.save({ port, token });
      setSettings(saved);
      setConnection("connecting");
      const outcome = await probeBridge(createBridge(port, token));
      if (mine !== generation.current) return; // superseded by a newer attempt
      if (outcome.state === "paired") {
        setBridge(outcome.bridge);
        setStyles(outcome.styles);
        setConnection("paired");
      } else {
        setBridge(null);
        setStyles([]);
        setConnection(outcome.state);
      }
    },
    [createBridge, store]
  );

  useEffect(() => {
    if (!autoConnect) return;
    const saved = store.load();
    if (saved.token) void connect(saved.port, saved.token);
  }, [autoConnect, store, connect]);

  const setStyleId = useCallback(
    (styleId: string) => {
      setSettings(store.save({ styleId }));
    },
    [store],
  );

  const reloadStyles = useCallback(async (): Promise<boolean> => {
    const b = bridge;
    if (b === null) return false;
    let res: BridgeResponse<{ styles: CitationStyle[] }>;
    try {
      res = await b.listStyles();
    } catch {
      // Bridge went away mid-session: keep the cached list, report the miss.
      return false;
    }
    if (!res.ok) return false;
    setStyles(res.styles);
    const next = reconcileStyleId(store.load().styleId, res.styles);
    if (next !== store.load().styleId) setSettings(store.save({ styleId: next }));
    return true;
  }, [bridge, store]);

  return { connection, settings, bridge, styles, connect, setStyleId, reloadStyles };
}
