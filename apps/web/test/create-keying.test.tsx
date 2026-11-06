/**
 * Creation keying: every new workspace carries a key bundle.
 *
 * - keyBundleForCreate: a session WITH the master key mints a fresh workspace
 *   key, wraps it under the master, and returns the bundle for the create
 *   payload; a keyless session (API-key sign-in) takes the directional arm.
 * - WorkspacesView create: the POST /api/workspaces body rides a wrappedKey
 *   (a b64u string); a keyless session surfaces the directional copy and NO
 *   create request fires; a server 422 `keying_required` message surfaces
 *   verbatim through the modal's error channel.
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
  WORKSPACE_CREATE_KEYING_COPY,
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

    const bundle = await keyBundleForCreate(SERVER, TOKEN);

    expect(bundle).toHaveProperty("wrappedKey");
    if (!("wrappedKey" in bundle)) throw new Error("expected the bundle arm");
    expect(bundle.wrappedKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // iv(12) + tag(16) + ct(32), base64url — no pre-flight PUT: creation
    // payloads carry the bundle.
    expect(atob(bundle.wrappedKey.replace(/-/g, "+").replace(/_/g, "/")).length).toBe(60);
    await expect(unwrapWorkspaceKey(handle.key, bundle.wrappedKey)).resolves.toBeDefined();
  });

  it("keyless session (API-key sign-in) → the directional arm, no bundle", async () => {
    const bundle = await keyBundleForCreate(SERVER, TOKEN);
    expect(bundle).toEqual({ directionalCopy: true });
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

  it("API-key session → the directional copy surfaces and NO create request fires", async () => {
    const fetchMock = workspacesFetchMock(() => Response.json({ id: "ws9" }));
    renderCreate(fetchMock);

    await submitCreate("New plots");

    expect(await screen.findByText(WORKSPACE_CREATE_KEYING_COPY)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith("/api/workspaces") && (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("server 422 keying_required → the server message surfaces verbatim", async () => {
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
