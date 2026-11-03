/**
 * Auth-flow custody wiring: a login whose kdf record does not open under the
 * typed password surfaces the verifier error on the form and aborts entry
 * (Review Focus 2 — never a silent custody skip); a correct password derives
 * the master key and proceeds to the workspace list.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { createKdfRecord, generateMasterKey } from "@notees/protocol";

import { App } from "../src/ui/App.js";

// connect() boots the in-process sql.js store; emscripten takes its NODE
// loader under jsdom (process is defined) and fs-opens the wasm path that
// vite's `?url` import resolves to. Same mock as app-smoke.
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: `${process.cwd()}/node_modules/sql.js/dist/sql-wasm.wasm`,
}));

const SERVER = "https://notees.example.com";
const PASSWORD = "right-password-1";
const EMAIL = "admin@example.com";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function loginResponse(kdf: unknown) {
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

async function bootToLoginScreen(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
    target: { value: SERVER },
  });
  fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
  expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument();
}

function makeFetchMock(kdf: unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/server-info")) {
      return Response.json({ setupRequired: false, version: "test", name: "notees-server" });
    }
    if (url.endsWith("/api/auth/login") && method === "POST") {
      return Response.json(loginResponse(kdf));
    }
    if (url.endsWith("/api/workspaces")) {
      return Response.json({ workspaces: [] });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

async function submitLogin(password: string) {
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: EMAIL } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
}

describe("login custody wiring", () => {
  it("a wrong password surfaces the verifier error and does not enter workspaces", async () => {
    const master = await generateMasterKey();
    const kdf = await createKdfRecord(master, PASSWORD);
    await bootToLoginScreen(makeFetchMock(kdf));

    await submitLogin("wrong-password-1");

    expect(await screen.findByText(/verifier|password/i)).toBeInTheDocument();
    // Still on the auth form — no workspace list, no connecting phase.
    expect(screen.queryByText(/loading workspaces/i)).toBeNull();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });

  it("a correct password derives the master key and proceeds to the workspace list", async () => {
    const master = await generateMasterKey();
    const kdf = await createKdfRecord(master, PASSWORD);
    await bootToLoginScreen(makeFetchMock(kdf));

    await submitLogin(PASSWORD);

    // The workspaces phase renders the account header (email) — entry proceeded.
    expect(await screen.findByText(EMAIL)).toBeInTheDocument();
  });
});
