/**
 * App smoke tests: the boot form shows the server URL field with Continue +
 * "Work offline" (no API key / workspace UUID prompts — accounts replaced
 * them), the server-info probe picks the setup vs login screen, and the
 * server URL is remembered.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { App, navFromPath, pathForNav } from "../src/ui/App.js";

// connect() boots the in-process sql.js store; emscripten takes its NODE
// loader under jsdom (process is defined) and fs-opens the wasm path that
// vite's `?url` import resolves to. Point the import at the real file so the
// client reaches the (stubbed) sync layer instead of aborting.
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: `${process.cwd()}/node_modules/sql.js/dist/sql-wasm.wasm`,
}));

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("App boot", () => {
  it("shows the server form with Continue and Work offline on first load", () => {
    render(<App />);
    expect(screen.getByRole("textbox", { name: /server url/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /work offline/i })).toBeInTheDocument();
    // No raw-credential prompts.
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(screen.queryByLabelText(/workspace id/i)).toBeNull();
  });

  it("remembers a previously entered server URL", () => {
    localStorage.setItem("notees.serverUrl", "https://notees.example.com");
    render(<App />);
    expect(screen.getByRole("textbox", { name: /server url/i })).toHaveValue(
      "https://notees.example.com",
    );
  });

  it("server-info with setupRequired shows the initial-setup screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/server-info")) {
          return Response.json({ setupRequired: true, version: "test", name: "notees-server" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
      target: { value: "https://notees.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/initial setup/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
  });

  it("server-info without setupRequired shows the login screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/server-info")) {
          return Response.json({ setupRequired: false, version: "test", name: "notees-server" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
      target: { value: "https://notees.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(await screen.findByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /email/i })).toBeInTheDocument();
  });

  it("a probe failure surfaces as an error, not a silent hang", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 502 })),
    );
    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
      target: { value: "https://down.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByText(/HTTP 502/i)).toBeInTheDocument());
  });
});

describe("session resume", () => {
  const ME = {
    id: "u1",
    email: "ada@example.com",
    displayName: "Ada",
    name: "Ada",
    surnames: null,
    avatarUrl: null,
    isAdmin: false,
  };

  function rememberSession(): void {
    localStorage.setItem("notees.serverUrl", "https://notees.example.com");
    localStorage.setItem("notees.sessionToken", "session-token");
    localStorage.setItem("notees.workspaceId", "ws1");
  }

  it("reload on /workspaces lands on the workspace manager, not the app shell", async () => {
    rememberSession();
    window.history.pushState({}, "", "/workspaces");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workspaces")) {
        return Response.json({
          workspaces: [
            { id: "ws1", name: "Garden", role: "owner", createdAt: 1, envelopeCount: 0, latestSeq: 0 },
          ],
        });
      }
      if (url.endsWith("/api/auth/me")) {
        return Response.json(ME);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    // The manager renders (welcome heading + the workspace card)…
    expect(await screen.findByText("Your workspaces")).toBeInTheDocument();
    expect(await screen.findByText("Garden")).toBeInTheDocument();
    // …without connecting into the remembered workspace (no relay traffic)…
    const calls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calls.some((url) => url.includes("/api/relay/"))).toBe(false);
    // …and the URL stays on /workspaces.
    expect(window.location.pathname).toBe("/workspaces");
    window.history.pushState({}, "", "/");
  });

  it("reload on /workspaces before any workspace is entered still resumes (session persisted at the manager)", async () => {
    // Fresh login: enterWorkspaces persisted serverUrl+sessionToken, but no
    // workspaceId exists yet — the manager must still come back on reload.
    localStorage.setItem("notees.serverUrl", "https://notees.example.com");
    localStorage.setItem("notees.sessionToken", "session-token");
    window.history.pushState({}, "", "/workspaces");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/workspaces")) {
          return Response.json({ workspaces: [] });
        }
        if (url.endsWith("/api/auth/me")) {
          return Response.json(ME);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<App />);
    expect(await screen.findByText(/create your first workspace/i)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/workspaces");
    window.history.pushState({}, "", "/");
  });

  it("a deep link to a node in another workspace connects to that workspace", async () => {
    rememberSession();
    const nodeId = "11111111-2222-4333-8444-555555555555";
    window.history.pushState({}, "", `/${nodeId}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/workspaces")) {
          return Response.json({
            workspaces: [
              { id: "ws1", name: "Garden", role: "owner", createdAt: 1, envelopeCount: 0, latestSeq: 0 },
              { id: "ws2", name: "Orchard", role: "owner", createdAt: 2, envelopeCount: 0, latestSeq: 0 },
            ],
          });
        }
        if (url.endsWith("/api/auth/me")) {
          return Response.json(ME);
        }
        if (url.endsWith(`/api/nodes/${nodeId}/location`)) {
          return Response.json({ workspaceId: "ws2" });
        }
        // Relay catch-up for the located workspace: unreachable, so connect
        // fails after recording which workspace it targeted.
        return new Response("unreachable", { status: 502 });
      }),
    );
    render(<App />);
    // connect() persists the workspace id before the (failing) sync: the
    // deep link must have rerouted the connection from ws1 to ws2.
    await waitFor(() =>
      expect(localStorage.getItem("notees.workspaceId")).toBe("ws2"),
    );
  });

  it("an unknown deep-link node falls back to the remembered workspace", async () => {
    rememberSession();
    window.history.pushState({}, "", "/11111111-2222-4333-8444-555555555555");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/workspaces")) {
          return Response.json({
            workspaces: [
              { id: "ws1", name: "Garden", role: "owner", createdAt: 1, envelopeCount: 0, latestSeq: 0 },
            ],
          });
        }
        if (url.endsWith("/api/auth/me")) {
          return Response.json(ME);
        }
        if (url.endsWith("/api/nodes/11111111-2222-4333-8444-555555555555/location")) {
          return new Response("not found", { status: 404 });
        }
        return new Response("unreachable", { status: 502 });
      }),
    );
    render(<App />);
    await waitFor(() =>
      expect(localStorage.getItem("notees.workspaceId")).toBe("ws1"),
    );
  });

  it("an expired session on /workspaces lands on the server form", async () => {
    rememberSession();
    window.history.pushState({}, "", "/workspaces");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/workspaces") || url.endsWith("/api/auth/me")) {
          return new Response("unauthorized", { status: 401 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<App />);
    // The failed validation clears the credential and offers the server form.
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /server url/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText("Your workspaces")).toBeNull();
    window.history.pushState({}, "", "/");
  });
});

describe("hub URL routes", () => {
  it("maps hub paths to nav keys (with the /journals alias)", () => {
    expect(navFromPath("/journal")).toBe("journal");
    expect(navFromPath("/journals")).toBe("journal");
    expect(navFromPath("/inbox")).toBe("inbox");
    expect(navFromPath("/pages")).toBe("pages");
    expect(navFromPath("/classes")).toBe("classes");
    expect(navFromPath("/whiteboards")).toBe("whiteboards");
    expect(navFromPath("/tasks")).toBe("tasks");
    expect(navFromPath("/tasks/")).toBe("tasks");
    expect(navFromPath("/")).toBeNull();
    expect(navFromPath("/workspaces")).toBeNull();
    expect(navFromPath("/11111111-2222-4333-8444-555555555555")).toBeNull();
  });

  it("round-trips nav keys through canonical paths", () => {
    for (const nav of ["journal", "inbox", "pages", "classes", "whiteboards", "tasks"] as const) {
      expect(navFromPath(pathForNav(nav))).toBe(nav);
    }
  });
});
