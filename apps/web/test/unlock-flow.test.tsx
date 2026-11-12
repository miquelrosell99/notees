/**
 * Unlock re-prompt tests (fail-loud ruling): a keyed workspace opened with no
 * master key REFUSES the connect — no client is created, no relay traffic
 * happens — and the UnlockWorkspaceModal takes over immediately. Cancel
 * returns to the workspace selector; the right password re-derives the
 * master key and opens the workspace sealed. API-key sessions get the
 * directional copy (no password path).
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
  // Relay traffic counter: a refused open must produce NONE of these.
  let relayCalls = 0;
  // Unlock-endpoint counter: the re-prompt must ride /auth/unlock, never
  // /auth/login (which would mint an unused session per unlock).
  let unlockCalls = 0;
  let loginCallsAfterSetup = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
            encrypted: true,
          },
        ],
      });
    }
    if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
      return Response.json({ wrappedKey });
    }
    if (url.endsWith("/api/auth/login") && method === "POST") {
      loginCallsAfterSetup += 1;
      const body = JSON.parse(String(init!.body)) as { password: string };
      if (body.password !== PASSWORD) {
        return Response.json({ error: { message: "Invalid credentials." } }, { status: 401 });
      }
      return Response.json(loginResponse());
    }
    if (url.endsWith("/api/auth/unlock") && method === "POST") {
      unlockCalls += 1;
      const body = JSON.parse(String(init!.body)) as { password: string };
      if (body.password !== PASSWORD) {
        return Response.json({ error: { message: "Invalid credentials." } }, { status: 401 });
      }
      // The endpoint's contract: the kdf record ONLY — no token, no session.
      return Response.json({ kdf });
    }
    if (url.includes("/api/relay/v2/snapshot?")) {
      relayCalls += 1;
      return Response.json({
        snapshotId: "",
        hlc: { physical: 0, logical: 0 },
        hasSnapshot: false,
        restoreEpoch: 0,
        upToSeq: null,
      });
    }
    if (url.endsWith("/api/relay/v2/catch-up")) {
      relayCalls += 1;
      return Response.json({
        envelopes: [],
        nextAfterSeq: null,
        hasMore: false,
        restoreEpoch: 0,
        totalRemaining: 0,
      });
    }
    if (url.includes("/api/relay/v2/snapshot/data?")) {
      relayCalls += 1;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/api/relay/v2/tickets")) {
      return Response.json({ ticket: "ticket" });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return {
    fetchMock,
    relayCalls: () => relayCalls,
    unlockCalls: () => unlockCalls,
    loginCalls: () => loginCallsAfterSetup,
  };
}

async function setupAccountAndOpenKeyed() {
  const counters = makeFetchMock();
  const { fetchMock } = counters;
  window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: "on" };
  vi.stubGlobal("fetch", fetchMock);
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
  return counters;
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

  it("API-key sessions get the direction copy instead of the password form", () => {
    render(
      <UnlockWorkspaceModal isOpen email="" apiKeySession onClose={() => {}} onSubmit={() => Promise.resolve()} />,
    );
    expect(screen.getByText(/sign in with your email and password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^back$/i })).toBeInTheDocument();
  });
});

describe("fail-loud open (App level)", () => {
  it("refuses the open — no client, no relay traffic, unlock modal immediately", async () => {
    const { relayCalls } = await setupAccountAndOpenKeyed();

    fireEvent.click(await screen.findByRole("button", { name: "Open Keyed" }));

    // The unlock modal takes over immediately, with the fail-loud copy.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/unlock encrypted workspace/i);
    expect(dialog).toHaveTextContent(/this workspace is encrypted/i);

    // No client was created: the app shell never rendered and the engine
    // never talked to the relay.
    expect(screen.queryByText("KEYED")).toBeNull();
    await waitFor(() => expect(relayCalls()).toBe(0));
  });

  it("cancel lands back on the workspace selector; a wrong password is a form error", async () => {
    await setupAccountAndOpenKeyed();
    fireEvent.click(await screen.findByRole("button", { name: "Open Keyed" }));
    const dialog = await screen.findByRole("dialog");

    // Cancel → back on the selector.
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Your workspaces")).toBeInTheDocument();

    // Re-open: the modal comes back; a wrong password is a form error.
    fireEvent.click(screen.getByRole("button", { name: "Open Keyed" }));
    const again = await screen.findByRole("dialog");
    fireEvent.change(within(again).getByLabelText(/^password$/i), { target: { value: "wrong-1" } });
    fireEvent.click(within(again).getByRole("button", { name: /^unlock$/i }));
    expect(await within(again).findByText(/invalid credentials/i)).toBeInTheDocument();
  });

  it("the right password re-derives the master key and opens the workspace sealed", async () => {
    const { relayCalls, unlockCalls, loginCalls } = await setupAccountAndOpenKeyed();
    fireEvent.click(await screen.findByRole("button", { name: "Open Keyed" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/^password$/i), { target: { value: PASSWORD } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^unlock$/i }));

    // The modal closes and the app shell opens with the workspace live.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("KEYED")).toBeInTheDocument();
    // This time the engine DID sync.
    await waitFor(() => expect(relayCalls()).toBeGreaterThan(0));
    // The unlock hygiene: the re-prompt rode /auth/unlock (kdf only), never
    // /auth/login (which would have minted an unused session). The one login
    // call on record is the initial account setup.
    expect(unlockCalls()).toBe(1);
    expect(loginCalls()).toBe(0);
  });
});
