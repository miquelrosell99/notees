/**
 * The E2EE kill switch is retired: workspace keying is UNCONDITIONAL.
 * `window.NOTEES_CONFIG.e2ee` stays typed for container compat but is inert —
 * absent, "off", or "on", the open path behaves identically.
 *
 * Keying is DELIBERATE (owner ruling): opening a workspace is READ-ONLY on
 * the key route — a plaintext workspace (GET 404) opens with NO key and the
 * client NEVER lazy-PUTs one; the 404 → generate + wrap + PUT sequence lives
 * only at creation (the bundle rides the create payload) and in the
 * deliberate keying call (`ensureWorkspaceKey`, the Task-10 banner action).
 * Offline still short-circuits keyless (no server → no keys → plaintext).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKdfRecord,
  generateMasterKey,
  generateWorkspaceKey,
  wrapWorkspaceKey,
} from "@notees/protocol";

import {
  clearCryptoCustody,
  deriveMasterKey,
  type MasterKeyHandle,
} from "../src/core/crypto-custody.js";
import { resolveWorkspaceKey } from "../src/ui/app/store-connection.js";

const SERVER = "https://notees.example.com";
const TOKEN = "session-token";
const WS = "0192a000-0000-7000-8000-000000000001";
const PASSWORD = "correct horse battery staple";

async function masterInMemory(): Promise<MasterKeyHandle> {
  const master = await generateMasterKey();
  return deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
}

/** Records key-route traffic so a test can assert NO lazy PUT fired. */
function keyRouteStub(wrapped: string | undefined) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
      if (wrapped === undefined) {
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      }
      return Response.json({ wrappedKey: wrapped });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

afterEach(() => {
  clearCryptoCustody();
  vi.unstubAllGlobals();
  delete window.NOTEES_CONFIG;
});

describe("keying is unconditional (the NOTEES_CONFIG.e2ee flag is inert)", () => {
  it.each([
    ["absent", undefined],
    ["off", "off"],
    ["on", "on"],
  ])(
    "flag %s + plaintext workspace (GET 404) → opens keyless, reports plaintext, NO lazy PUT",
    async (_label, flag) => {
      if (flag !== undefined) window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: flag };
      await masterInMemory();
      const fetchMock = keyRouteStub(undefined);
      vi.stubGlobal("fetch", fetchMock);

      const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
        isOffline: false,
        credentialType: "session",
        label: "Workspace",
      });

      expect(resolution).toEqual({ key: undefined, locked: false, plaintext: true });
      // Read-only open: exactly one GET, never a PUT — keying is deliberate.
      expect(fetchMock.mock.calls).toHaveLength(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(`${SERVER}/api/workspaces/${WS}/key`);
    },
  );

  it.each([
    ["absent", undefined],
    ["off", "off"],
    ["on", "on"],
  ])(
    "flag %s + keyed workspace (GET 200) → unwraps to the 32-byte key, no PUT",
    async (_label, flag) => {
      if (flag !== undefined) window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: flag };
      const master = await generateMasterKey();
      const handle = await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
      const workspaceKey = await generateWorkspaceKey();
      const wrapped = await wrapWorkspaceKey(handle.key, workspaceKey);
      const fetchMock = keyRouteStub(wrapped);
      vi.stubGlobal("fetch", fetchMock);

      const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
        isOffline: false,
        credentialType: "session",
        label: "Workspace",
      });

      expect(resolution.key).toBeInstanceOf(Uint8Array);
      expect(resolution.key!.length).toBe(32);
      expect(resolution.locked).toBe(false);
      expect(resolution.plaintext).toBe(false);
      expect(fetchMock.mock.calls).toHaveLength(1);
    },
  );

  it("a key wrapped for a DIFFERENT master opens locked (fail loud, no PUT)", async () => {
    await masterInMemory();
    const otherMaster = await generateMasterKey();
    const workspaceKey = await generateWorkspaceKey();
    const wrapped = await wrapWorkspaceKey(otherMaster, workspaceKey);
    const fetchMock = keyRouteStub(wrapped);
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution).toEqual({ key: undefined, locked: true, plaintext: false });
    // The locked arm's confirmation probe re-GETs; the pin is that keying
    // never happens — no PUT, only GETs.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    }
  });

  it("offline still short-circuits keyless (no server → no keys), flag regardless", async () => {
    await masterInMemory();
    const fetchMock = vi.fn(async () => {
      throw new Error("offline connect must not touch the network");
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, "", WS, {
      isOffline: true,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution).toEqual({ key: undefined, locked: false, plaintext: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
