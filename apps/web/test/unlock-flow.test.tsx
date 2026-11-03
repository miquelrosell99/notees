/**
 * Unlock re-prompt tests (plan-04 W2): a keyed workspace opened keyless shows
 * the locked banner; Unlock opens the modal; a wrong password is a form
 * error; the server lockout (429) is surfaced distinctly; the right password
 * re-derives the master key and the reconnect clears the banner.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  createKdfRecord,
  generateMasterKey,
  generateWorkspaceKey,
  wrapWorkspaceKey,
} from "@notees/protocol";

import { App } from "../src/ui/App.js";
import { AuthRequestError } from "../src/core/auth-api.js";
import { clearCryptoCustody } from "../src/core/crypto-custody.js";
import { UnlockWorkspaceModal } from "../src/features/modals/UnlockWorkspaceModal.js";

// The in-process store boots sql.js under jsdom (process defined): point the
// ?url asset imports at the real files (app-smoke pattern).
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: `${process.cwd()}/node_modules/sql.js/dist/sql-wasm.wasm`,
}));
vi.mock("@sqlite.org/sqlite-wasm/sqlite3.wasm?url", () => ({
  default: `${process.cwd()}/node_modules/@sqlite.org/sqlite-wasm/sqlite3.wasm`,
}));

const SERVER = "https://notees.example.com";
const EMAIL = "admin@example.com";
const PASSWORD = "right-password-1";
const WS = "0192a000-0000-7000-8000-000000000001";

/** The account's kdf record and the workspace's wrapped key, built once. */
let kdf: unknown;
let wrappedKey: string;

beforeAll(async () => {
  const master = await generateMasterKey();
  kdf = await createKdfRecord(master, PASSWORD);
  const workspaceKey = await generateWorkspaceKey();
  wrappedKey = await wrapWorkspaceKey(master, workspaceKey);
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  delete window.NOTEES_CONFIG;
  clearCryptoCustody();
});

function loginResponse() {
  return {
    token: "session-token",
    expiresAt: Date.now() + 86_400_000,
    user: {
      id: "0192a000-0000-7000-8000-0000000000u1",
      email: EMAIL,
      displayName: null,
      name: null,
      surnames: null,
      avatarUrl: null,
      isAdmin: true,
    },
    kdf,
  };
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/server-info")) {
      return Response.json({ setupRequired: true, version: "test", name: "notees-server" });
    }
    if (url.endsWith("/api/setup") && method === "POST") {
      return Response.json(loginResponse(), { status: 201 });
    }
    if (url.endsWith("/api/workspaces") && !url.includes("/key") && method === "GET") {
      return Response.json({
        workspaces: [
          {
            id: WS,
            name: "Keyed",
            role: "owner",
            createdAt: 1,
            envelopeCount: 0,
            latestSeq: 0,
          },
        ],
      });
    }
    if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
      return Response.json({ wrappedKey });
    }
    if (url.endsWith("/api/auth/login") && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { password: string };
      if (body.password !== PASSWORD) {
        return Response.json({ error: { message: "Invalid credentials." } }, { status: 401 });
      }
      return Response.json(loginResponse());
    }
    if (url.includes("/api/relay/v2/snapshot?")) {
      return Response.json({
        snapshotId: "",
        hlc: { physical: 0, logical: 0 },
        hasSnapshot: false,
        restoreEpoch: 0,
        upToSeq: null,
      });
    }
    if (url.endsWith("/api/relay/v2/catch-up")) {
      return Response.json({
        envelopes: [],
        nextAfterSeq: null,
        hasMore: false,
        restoreEpoch: 0,
        totalRemaining: 0,
      });
    }
    if (url.includes("/api/relay/v2/snapshot/data?")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/api/relay/v2/tickets")) {
      return Response.json({ ticket: "ticket" });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

describe("UnlockWorkspaceModal", () => {
  it("maps the server lockout (429) to a distinct 'too many attempts' message", async () => {
    render(
      <UnlockWorkspaceModal
        isOpen
        email={EMAIL}
        onClose={() => {}}
        onSubmit={() => Promise.reject(new AuthRequestError(429, "account locked — retry after 300s"))}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "whatever-1" } });
    fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
  });

  it("shows a wrong password as the form error and closes on success", async () => {
    let calls = 0;
    const onSubmit = vi.fn(async (password: string) => {
      calls += 1;
      if (calls === 1) throw new Error("master-key verifier mismatch (wrong password)");
      expect(password).toBe(PASSWORD);
    });
    const onClose = vi.fn();
    render(<UnlockWorkspaceModal isOpen email={EMAIL} onClose={onClose} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "wrong-1" } });
    fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
    expect(await screen.findByText(/verifier mismatch/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("unlock re-prompt (App level)", () => {
  it("locked banner → wrong password error → unlock reconnects and clears the banner", async () => {
    window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: "on" };
    vi.stubGlobal("fetch", makeFetchMock());
    render(<App />);

    // Boot → initial setup → create account (the app derives the master key).
    fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
      target: { value: SERVER },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(await screen.findByLabelText(/^email$/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: EMAIL } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText(/^confirm password$/i), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByText(/Keyed/)).toBeInTheDocument();

    // Simulate the reload: the session token persists, the master key drops.
    clearCryptoCustody();

    // Open the workspace: keyed but locked → the banner appears.
    fireEvent.click(await screen.findByRole("button", { name: "Open Keyed" }));
    expect(await screen.findByText(/no key/i)).toBeInTheDocument();

    // Unlock: wrong password is a form error…
    fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/unlock encrypted workspace/i);
    const passwordField = () => within(dialog).getByLabelText(/^password$/i);
    fireEvent.change(passwordField(), { target: { value: "wrong-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^unlock$/i }));
    expect(await within(dialog).findByText(/invalid credentials/i)).toBeInTheDocument();

    // …the right password re-derives the master key and the reconnect clears
    // the banner (resolveWorkspaceKey now unwraps the stored key).
    fireEvent.change(passwordField(), { target: { value: PASSWORD } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^unlock$/i }));
    await waitFor(() => expect(screen.queryByText(/no key/i)).toBeNull());
  });
});
