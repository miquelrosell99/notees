/**
 * useServerProbe — the server-probe half of the boot flow: URL entry →
 * /server-info → setup/login phase, plus the error hint and the same-host
 * suggestion surfaced after a failed probe.
 *
 * Owns the server URL field, the signup flag the login tab reads, and the
 * probe handlers. connectTo is the single connect path for the boot form
 * and the settings Sync tab (identical behavior everywhere). The
 * phase/error state it drives lives in useWorkspaceConnection (passed in).
 */

import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

import { fetchServerInfo } from "@/core/auth-api.js";
import { initialServerUrl, sameHostServerUrl } from "./storage.js";
import type { WorkspaceConnection } from "./useWorkspaceConnection.js";

export interface ServerProbe {
  serverUrl: string;
  setServerUrl: Dispatch<SetStateAction<string>>;
  /**
   * NOTEES_SIGNUP_ENABLED as reported by /server-info: the login screen's
   * "No account yet? Create one" affordance renders only when the server
   * advertises it (the route 404s regardless when the flag is off).
   */
  signupEnabled: boolean;
  hint: string | null;
  setHint: Dispatch<SetStateAction<string | null>>;
  /**
   * Same-host guess offered under the boot form after a failed probe
   * (TypeError only). Clicking the suggestion button is the only path to the
   * guess — the boot screen never silently re-routes.
   */
  serverSuggestion: string | null;
  setServerSuggestion: Dispatch<SetStateAction<string | null>>;
  /** The settings Sync tab reuses the boot form's probe path. */
  connectTo: (rawUrl: string) => Promise<void>;
  handleServerSubmit: (event: FormEvent) => Promise<void>;
  handleServerSuggestion: () => Promise<void>;
}

export function useServerProbe(conn: WorkspaceConnection): ServerProbe {
  const { setPhase, setError } = conn;
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [serverSuggestion, setServerSuggestion] = useState<string | null>(null);

  async function probeServer(url: string): Promise<void> {
    const info = await fetchServerInfo(url);
    setServerUrl(url);
    // Older servers predate the field — treat absent as closed.
    setSignupEnabled(info.signupEnabled === true);
    if (info.setupRequired) {
      setPhase({ name: "setup" });
    } else {
      setPhase({ name: "login" });
    }
  }

  /**
   * Probe `rawUrl` and advance to setup/login on success — the single
   * connect path for the boot form and the settings Sync tab (identical
   * behavior everywhere). On failure the error + hint surface under the boot
   * form; a failed fetch (TypeError — unreachable host, connection refused,
   * CORS preflight block) additionally offers the same-host guess as an
   * explicit suggestion.
   */
  async function connectTo(rawUrl: string): Promise<void> {
    setError(null);
    setHint(null);
    setServerSuggestion(null);
    const url = rawUrl.trim().replace(/\/$/, "");
    try {
      await probeServer(url);
      return;
    } catch (err) {
      // Whatever the cause, the single most common fix on first connect is
      // the same-host guess (hand-typed "localhost" points at the user's own
      // device) — offered, never taken automatically.
      const guess = sameHostServerUrl();
      if (err instanceof TypeError && guess !== "" && guess !== url) {
        setServerSuggestion(guess);
      }
      setError(err instanceof Error ? err.message : String(err));
      // Browsers block plain-http fetches from an https page as mixed
      // content — the failure surfaces as a bare NetworkError, so name the
      // law when it applies (the sync API must be same-origin https here,
      // or the page itself reached over http).
      const mixedContent =
        typeof location !== "undefined" &&
        location.protocol === "https:" &&
        url.startsWith("http://");
      setHint(
        mixedContent
          ? "This page is https, and browsers block http API calls from it " +
            "(mixed content) before they leave the device. Use the page " +
            "origin (the suggested address), or reach the web UI over http " +
            "to use a plain-http sync address."
          : "Could not reach a sync server at that address. Check that the URL " +
            "points at the machine running the sync server — not this device — " +
            "and that the port is reachable (a firewall or a reverse proxy can " +
            "also block it).",
      );
    }
  }

  async function handleServerSubmit(event: FormEvent) {
    event.preventDefault();
    await connectTo(serverUrl);
  }

  /** The suggestion button is the ONLY path to the guess: an explicit click. */
  async function handleServerSuggestion() {
    if (serverSuggestion === null) return;
    const guess = serverSuggestion;
    setServerUrl(guess);
    setServerSuggestion(null);
    await connectTo(guess);
  }

  return {
    serverUrl,
    setServerUrl,
    signupEnabled,
    hint,
    setHint,
    serverSuggestion,
    setServerSuggestion,
    connectTo,
    handleServerSubmit,
    handleServerSuggestion,
  };
}
