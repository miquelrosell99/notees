/**
 * Creation keying: every new workspace carries a key bundle when the session
 * can mint one — the keyless arm defers to the server.
 *
 * - keyBundleForCreate: a session WITH the master key mints a fresh workspace
 *   key, wraps it under the master, and returns the bundle for the create
 *   payload; a keyless session (API-key sign-in) gets null and the caller
 *   fires the create WITHOUT a wrappedKey — the server decides:
 *   NOTEES_REQUIRE_KEYED on → the pinned 422 `keying_required` body (its own
 *   directional sentence) surfaces verbatim through the surface's existing
 *   error channel; the hatch off (`=0`) → the legacy unkeyed 201.
 * - WorkspacesView create: the POST /api/workspaces body rides a wrappedKey
 *   (a b64u string) under a password session; a keyless session POSTs with
 *   no wrappedKey and the server's answer stands.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  createKdfRecord,
  generateMasterKey,
  unwrapWorkspaceKey,
} from "@notees/protocol";

import {
  clearCryptoCustody,
  deriveMasterKey,
  keyBundleForCreate,
} from "../src/core/crypto-custody.js";
import { WorkspacesView } from "../src/features/workspaces/WorkspacesView.js";

const SERVER = "https://notees.example.com";
const TOKEN = "session-token";
const PASSWORD = "correct horse battery staple";

async function masterInMemory() {
  const master = await generateMasterKey();
  const handle = await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
  return { master, handle };
}

afterEach(() => {
  clearCryptoCustody();
  vi.unstubAllGlobals();
});

describe("keyBundleForCreate", () => {
  it("master key in memory → a wrappedKey bundle openable under the master", async () => {
    const { handle } = await masterInMemory();

    const bundle = await keyBundleForCreate();

    expect(bundle).not.toBeNull();
    if (bundle === null) throw new Error("expected the bundle arm");
    expect(bundle.wrappedKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // iv(12) + tag(16) + ct(32), base64url — no pre-flight PUT: creation
    // payloads carry the bundle.
    expect(atob(bundle.wrappedKey.replace(/-/g, "+").replace(/_/g, "/")).length).toBe(60);
    await expect(unwrapWorkspaceKey(handle.key, bundle.wrappedKey)).resolves.toBeDefined();
  });

  it("keyless session (API-key sign-in) → null — no bundle, the server decides", async () => {
    const bundle = await keyBundleForCreate();
    expect(bundle).toBeNull();
  });
});

describe("WorkspacesView create keying", () => {
  function renderCreate(
    fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) {
    vi.stubGlobal("fetch", fetchMock);
    const onEnter = vi.fn();
    render(
      <WorkspacesView
        serverUrl={SERVER}
        credential={TOKEN}
        user={null}
        activeWorkspaceId="ws1"
        onEnter={onEnter}
      />,
    );
    return onEnter;
  }

  function workspacesFetchMock(post: (body: string | null) => Response) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/workspaces") && method === "GET") {
        return Response.json({ workspaces: [] });
      }
      if (url.endsWith("/api/workspaces") && method === "POST") {
        return post((init?.body as string | undefined) ?? null);
      }
      return new Response("unexpected", { status: 500 });
    });
  }

  async function submitCreate(name: string) {
    fireEvent.click(await screen.findByRole("button", { name: /create workspace/i }));
    fireEvent.change(screen.getByLabelText("Workspace Name"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "Create Workspace" }));
  }

  it("password session → the create POST carries a wrappedKey bundle", async () => {
    await masterInMemory();
    let postBody: string | null = null;
    const onEnter = renderCreate(
      workspacesFetchMock((body) => {
        postBody = body;
        return Response.json({ id: "ws9" });
      }),
    );

    await submitCreate("New plots");

    await waitFor(() => expect(onEnter).toHaveBeenCalledWith("ws9", "New plots"));
    const parsed = JSON.parse(postBody!) as { name?: string; wrappedKey?: string };
    expect(parsed.name).toBe("New plots");
    expect(parsed.wrappedKey).toEqual(expect.any(String));
    expect(parsed.wrappedKey!).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("API-key session → the create POST fires WITHOUT a wrappedKey; a keyed-required server answers 422 and the SERVER's copy surfaces verbatim", async () => {
    const serverCopy =
      "workspace keying is required — create the workspace with a wrappedKey bundle (sign in with your email and password to create one)";
    let postBody: string | null = null;
    const fetchMock = workspacesFetchMock((body) => {
      postBody = body;
      return Response.json({ error: { code: "keying_required", message: serverCopy } }, { status: 422 });
    });
    const onEnter = renderCreate(fetchMock);

    await submitCreate("New plots");

    expect(await screen.findByText(serverCopy)).toBeInTheDocument();
    expect(onEnter).not.toHaveBeenCalled();
    // The client did NOT pre-flight: the POST fired without a bundle and
    // the server decided (hatch on) — the escape hatch stays server-side.
    const parsed = JSON.parse(postBody!) as { wrappedKey?: string };
    expect(parsed.wrappedKey).toBeUndefined();
  });

  it("keyless session + a legacy server (NOTEES_REQUIRE_KEYED=0) → the unkeyed 201 stands — the escape hatch works", async () => {
    let postBody: string | null = null;
    const onEnter = renderCreate(
      workspacesFetchMock((body) => {
        postBody = body;
        return Response.json({ id: "ws9" });
      }),
    );

    await submitCreate("New plots");

    await waitFor(() => expect(onEnter).toHaveBeenCalledWith("ws9", "New plots"));
    const parsed = JSON.parse(postBody!) as { name?: string; wrappedKey?: string };
    expect(parsed.name).toBe("New plots");
    expect(parsed.wrappedKey).toBeUndefined();
  });

  it("server 422 keying_required (a password session against a flipped-hatch server) → the server message surfaces verbatim", async () => {
    await masterInMemory();
    const message =
      "workspace keying is required — create the workspace with a wrappedKey bundle (sign in with your email and password to create one)";
    const onEnter = renderCreate(
      workspacesFetchMock(() =>
        Response.json({ error: { code: "keying_required", message } }, { status: 422 }),
      ),
    );

    await submitCreate("New plots");

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onEnter).not.toHaveBeenCalled();
  });
});
