/**
 * The not-encrypted banner + deliberate keying surface (the open-time keying
 * path besides creation). Pins:
 *
 * Banner level:
 *  - the plaintext variant renders the pinned copy with an enabled Key action
 *  - the keyed variant renders the honest post-keying copy ("New content is
 *    encrypted. Content written before keying is not.")
 *  - a keyless session disables the Key action with the established
 *    directional sentence
 *  - dismissal is session-local state (never persisted)
 *  - a keying failure surfaces in the banner instead of vanishing
 *
 * App level:
 *  - a plaintext workspace (key route 404) opens WITH the banner
 *  - a keyed workspace opens WITHOUT it
 *  - "Key this workspace" PUTs the wrap, reconnects (so the engine seals from
 *    here on), and leaves the honest post-keying copy
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  createKdfRecord,
  generateMasterKey,
  generateWorkspaceKey,
  unwrapMasterKeyWithBytes,
  wrapWorkspaceKey,
  type KdfRecord,
} from "@notees/protocol";

import { App } from "../src/ui/App.js";
import {
  NotEncryptedBanner,
  WORKSPACE_KEYING_COPY,
} from "../src/components/ui/kit/NotEncryptedBanner.js";
import { clearCryptoCustody } from "../src/core/crypto-custody.js";

// The in-process store boots sql.js under jsdom (process defined): point the
// ?url asset imports at the real files (unlock-flow / app-smoke pattern).
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

const WARNING_COPY = "This workspace is not encrypted — new content is readable on the server.";
const KEYED_COPY = "New content is encrypted. Content written before keying is not.";

/** The account's kdf record, built once. */
let kdf: unknown;

beforeAll(async () => {
  const master = await generateMasterKey();
  kdf = await createKdfRecord(master, PASSWORD);
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  delete window.NOTEES_CONFIG;
  clearCryptoCustody();
});

describe("NotEncryptedBanner (kit)", () => {
  it("renders the pinned warning copy with an enabled Key action", () => {
    render(<NotEncryptedBanner onKey={() => Promise.resolve()} keyDisabled={false} />);
    expect(screen.getByText(WARNING_COPY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Key this workspace" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("the keyed variant renders the honest post-keying copy with no Key action", () => {
    render(
      <NotEncryptedBanner
        onKey={() => Promise.resolve()}
        keyDisabled={false}
        keyed
        onDismissKeyed={() => {}}
      />,
    );
    expect(screen.getByText(KEYED_COPY)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Key this workspace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("a keyless session disables the Key action with the keying directional copy", () => {
    render(
      <NotEncryptedBanner
        onKey={() => Promise.resolve()}
        keyDisabled
        keyDisabledHint={WORKSPACE_KEYING_COPY}
      />,
    );
    const keyButton = screen.getByRole("button", { name: "Key this workspace" });
    expect(keyButton).toBeDisabled();
    // The keying-specific directional sentence (names keying, not creation).
    expect(screen.getByText(WORKSPACE_KEYING_COPY)).toBeInTheDocument();
    expect(screen.getByText(WORKSPACE_KEYING_COPY)).toHaveTextContent(
      "Sign in with your email and password to key this workspace.",
    );
  });

  it("dismissal is session-local state — the banner unmounts, nothing persists", () => {
    const { container } = render(
      <NotEncryptedBanner onKey={() => Promise.resolve()} keyDisabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(container).toBeEmptyDOMElement();
    // Never persisted: the next mount shows it again.
    const again = render(<NotEncryptedBanner onKey={() => Promise.resolve()} keyDisabled={false} />);
    expect(again.container).not.toBeEmptyDOMElement();
  });

  it("a keying failure surfaces in the banner instead of vanishing", async () => {
    render(
      <NotEncryptedBanner
        onKey={() => Promise.reject(new Error("wrap upload failed (test)"))}
        keyDisabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Key this workspace" }));
    expect(await screen.findByText(/wrap upload failed \(test\)/)).toBeInTheDocument();
    // The warning copy survives the failure.
    expect(screen.getByText(WARNING_COPY)).toBeInTheDocument();
  });
});

/**
 * App-level harness: boot → initial setup → account (master key derived) →
 * workspace list → open. The key route starts keyless (404); the PUT the
 * keying action performs stores the wrap the later GETs answer with.
 */
function makeFetchMock(options: { workspaceEncrypted: boolean }) {
  const calls = { keyGet: 0, keyPut: 0, relayCalls: 0 };
  let storedWrappedKey: string | null = null;
  if (options.workspaceEncrypted) storedWrappedKey = "pending";

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/server-info")) {
      return Response.json({ setupRequired: true, version: "test", name: "notees-server" });
    }
    if (url.endsWith("/api/setup") && method === "POST") {
      return Response.json(
        {
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
        },
        { status: 201 },
      );
    }
    if (url.endsWith("/api/workspaces") && !url.includes("/key") && method === "GET") {
      return Response.json({
        workspaces: [
          {
            id: WS,
            name: "Plain",
            role: "owner",
            createdAt: 1,
            envelopeCount: 0,
            latestSeq: 0,
            encrypted: options.workspaceEncrypted,
          },
        ],
      });
    }
    if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
      calls.keyGet += 1;
      if (storedWrappedKey === "pending") {
        // A pre-keyed workspace: the server already holds a wrap minted under
        // the account master at creation. Rebuild it under the SAME master
        // the session derives from the login kdf (a foreign master fails the
        // unwrap and the open refuses — fail loud).
        const { key } = await unwrapMasterKeyWithBytes(PASSWORD, kdf as KdfRecord);
        const workspaceKey = await generateWorkspaceKey();
        storedWrappedKey = await wrapWorkspaceKey(key, workspaceKey);
      }
      if (storedWrappedKey === null) {
        return Response.json({ error: { message: "no key" } }, { status: 404 });
      }
      return Response.json({ wrappedKey: storedWrappedKey });
    }
    if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "PUT") {
      calls.keyPut += 1;
      const body = JSON.parse(String(init!.body)) as { wrappedKey: string };
      storedWrappedKey = body.wrappedKey;
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/relay/v2/snapshot?")) {
      calls.relayCalls += 1;
      return Response.json({
        snapshotId: "",
        hlc: { physical: 0, logical: 0 },
        hasSnapshot: false,
        restoreEpoch: 0,
        upToSeq: null,
      });
    }
    if (url.endsWith("/api/relay/v2/catch-up")) {
      calls.relayCalls += 1;
      return Response.json({
        envelopes: [],
        nextAfterSeq: null,
        hasMore: false,
        restoreEpoch: 0,
        totalRemaining: 0,
      });
    }
    if (url.includes("/api/relay/v2/snapshot/data?")) {
      calls.relayCalls += 1;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/api/relay/v2/tickets")) {
      return Response.json({ ticket: "ticket" });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { fetchMock, calls };
}

async function bootAccountAndOpen() {
  const { fetchMock, calls } = makeFetchMock({ workspaceEncrypted: false });
  window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: "on" };
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
    target: { value: SERVER },
  });
  fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
  expect(await screen.findByLabelText(/^email$/i)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: EMAIL } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: PASSWORD } });
  fireEvent.change(screen.getByLabelText(/^confirm password$/i), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
  expect(await screen.findByText("Your workspaces")).toBeInTheDocument();

  fireEvent.click(await screen.findByRole("button", { name: "Open Plain" }));
  // The ready shell names the workspace.
  expect(await screen.findByText("PLAIN")).toBeInTheDocument();
  return { fetchMock, calls };
}

describe("not-encrypted banner (App level)", () => {
  it("a plaintext workspace opens WITH the banner and its pinned copy", async () => {
    const { calls } = await bootAccountAndOpen();
    expect(await screen.findByText(WARNING_COPY)).toBeInTheDocument();
    // Positive knowledge only: the open did exactly ONE key-route GET.
    expect(calls.keyGet).toBe(1);
  });

  it("a keyed workspace opens WITHOUT the banner", async () => {
    const { fetchMock } = makeFetchMock({ workspaceEncrypted: true });
    window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: "on" };
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
      target: { value: SERVER },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(await screen.findByLabelText(/^email$/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: EMAIL } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText(/^confirm password$/i), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByText("Your workspaces")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Open Plain" }));
    expect(await screen.findByText("PLAIN")).toBeInTheDocument();

    expect(screen.queryByText(WARNING_COPY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Key this workspace" })).toBeNull();
  });

  it("Key this workspace PUTs the wrap, reconnects, and leaves the honest copy", async () => {
    const { fetchMock, calls } = await bootAccountAndOpen();
    expect(await screen.findByText(WARNING_COPY)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Key this workspace" }));

    // The deliberate keying: exactly one PUT carries the wrap…
    await waitFor(() => expect(calls.keyPut).toBe(1));
    const putCall = fetchMock.mock.calls.find((call) => {
      const init = call[1] as RequestInit | undefined;
      return String(call[0]).endsWith(`/api/workspaces/${WS}/key`) && init?.method === "PUT";
    });
    expect(putCall).toBeDefined();
    const putBody = JSON.parse(String((putCall![1] as RequestInit).body)) as { wrappedKey: string };
    expect(putBody.wrappedKey).toMatch(/^[A-Za-z0-9_-]+$/);

    // …then the reconnect re-opens the workspace (the engine seals from here
    // on) and the banner's honest post-keying copy takes over.
    expect(await screen.findByText(KEYED_COPY)).toBeInTheDocument();
    expect(screen.queryByText(WARNING_COPY)).toBeNull();
    expect(await screen.findByText("PLAIN")).toBeInTheDocument();

    // Dismissal clears the notice. The in-process store banner (jsdom has no
    // Worker/OPFS) renders its own "Dismiss" — scope to this banner.
    const dismiss = document.querySelector(
      ".not-encrypted-banner .not-encrypted-banner__dismiss",
    );
    expect(dismiss).not.toBeNull();
    fireEvent.click(dismiss!);
    expect(screen.queryByText(KEYED_COPY)).toBeNull();
  });
});
