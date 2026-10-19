/**
 * useAuthFlow — the credential half of the boot flow: the account form
 * fields, the account/API-key tab, the signed-in identity (user + token),
 * and the setup/login/signup/API-key submit handlers with session
 * persistence.
 *
 * Credentials land on the workspace manager (the workspaces phase): the
 * workspace list itself is owned by useBootFlow and handed in via
 * setWorkspaces. The server URL the submits target comes from
 * useServerProbe (handed in). The phase/error state the handlers drive
 * lives in useWorkspaceConnection (passed in).
 */

import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

import {
  listWorkspaces,
  login,
  setupAccount,
  signup,
  type AccountUser,
  type WorkspaceEntry,
} from "@/core/auth-api.js";
import { rememberWorkspaceList } from "@/core/workspace-registry.js";
import { STORAGE_KEYS, clearStored, readStored, writeStored } from "./storage.js";
import type { WorkspaceConnection } from "./useWorkspaceConnection.js";

export interface AuthFlow {
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  password: string;
  setPassword: Dispatch<SetStateAction<string>>;
  passwordConfirm: string;
  setPasswordConfirm: Dispatch<SetStateAction<string>>;
  displayName: string;
  setDisplayName: Dispatch<SetStateAction<string>>;
  authTab: "account" | "apikey";
  setAuthTab: Dispatch<SetStateAction<"account" | "apikey">>;
  apiKeyInput: string;
  setApiKeyInput: Dispatch<SetStateAction<string>>;
  user: AccountUser | null;
  setUser: Dispatch<SetStateAction<AccountUser | null>>;
  token: string;
  setToken: Dispatch<SetStateAction<string>>;
  handleSetup: (event: FormEvent) => Promise<void>;
  handleLogin: (event: FormEvent) => Promise<void>;
  handleSignup: (event: FormEvent) => Promise<void>;
  handleApiKeySubmit: (event: FormEvent) => Promise<void>;
}

export interface AuthFlowDeps {
  conn: WorkspaceConnection;
  /** The server URL the submit handlers target (owned by useServerProbe). */
  serverUrl: string;
  /** Writes the normalized server URL back after the API-key submit. */
  setServerUrl: Dispatch<SetStateAction<string>>;
  /** Clears the boot form's hint, owned by useServerProbe. */
  setHint: Dispatch<SetStateAction<string | null>>;
  /** The workspace list the manager phase renders (owned by useBootFlow). */
  setWorkspaces: Dispatch<SetStateAction<WorkspaceEntry[]>>;
  pushNav: (url: string, state: Record<string, unknown>) => void;
}

export function useAuthFlow({ conn, serverUrl, setServerUrl, setHint, setWorkspaces, pushNav }: AuthFlowDeps): AuthFlow {
  const { setError, setSessionSignedIn, setPhase } = conn;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [token, setToken] = useState(() => readStored(STORAGE_KEYS.sessionToken));
  const [authTab, setAuthTab] = useState<"account" | "apikey">("account");
  const [apiKeyInput, setApiKeyInput] = useState("");

  async function enterWorkspaces(url: string, sessionToken: string, account: AccountUser) {
    setUser(account);
    setToken(sessionToken);
    // Persist the session NOW (not only after connect): a reload while the
    // manager is open must resume back onto it instead of the server form.
    writeStored(STORAGE_KEYS.serverUrl, url);
    writeStored(STORAGE_KEYS.sessionToken, sessionToken);
    clearStored(STORAGE_KEYS.apiKey);
    setSessionSignedIn(true);
    setPhase({ name: "connecting", label: "Loading workspaces…" });
    try {
      const { workspaces: list } = await listWorkspaces(url, sessionToken);
      setWorkspaces(list);
      rememberWorkspaceList(list);
      pushNav("/workspaces", { view: "workspaces" });
      setPhase({ name: "workspaces", user: account });
    } catch (err) {
      setPhase({ name: "server" });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSetup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== passwordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    try {
      const response = await setupAccount(serverUrl, {
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
      });
      await enterWorkspaces(serverUrl, response.token, response.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const response = await login(serverUrl, { email: email.trim(), password });
      await enterWorkspaces(serverUrl, response.token, response.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSignup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== passwordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    try {
      const response = await signup(serverUrl, { email: email.trim(), password });
      await enterWorkspaces(serverUrl, response.token, response.user);
    } catch (err) {
      // A 404 here means the server closed signups after the client probed it
      // — say so instead of showing the server's bare "not found".
      const message = err instanceof Error ? err.message : String(err);
      setError(message.toLowerCase() === "not found" ? "Signups are disabled on this server." : message);
    }
  }

  async function handleApiKeySubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setHint(null);
    let url = serverUrl.trim().replace(/\/$/, "");
    const key = apiKeyInput.trim();
    if (key === "") {
      setError("Enter an API key.");
      return;
    }
    try {
      // Validating against /workspaces also proves the key: a user API key
      // authenticates as its owner (routes-auth requireUser). No silent
      // same-host fallback (the owner ruling: never re-route without an
      // explicit user action) — a NetworkError surfaces with the suggestion
      // path, same as the account flow.
      const list = (await listWorkspaces(url, key)).workspaces;
      setServerUrl(url);
      setToken(key);
      // Persist the key NOW (not only after connect): a reload while the
      // manager is open must resume back onto it instead of the server form.
      writeStored(STORAGE_KEYS.serverUrl, url);
      writeStored(STORAGE_KEYS.apiKey, key);
      clearStored(STORAGE_KEYS.sessionToken);
      setWorkspaces(list);
      setPhase({ name: "workspaces", user: { id: "", email: "API key", displayName: null, name: null, surnames: null, avatarUrl: null, isAdmin: false } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    email,
    setEmail,
    password,
    setPassword,
    passwordConfirm,
    setPasswordConfirm,
    displayName,
    setDisplayName,
    authTab,
    setAuthTab,
    apiKeyInput,
    setApiKeyInput,
    user,
    setUser,
    token,
    setToken,
    handleSetup,
    handleLogin,
    handleSignup,
    handleApiKeySubmit,
  };
}
