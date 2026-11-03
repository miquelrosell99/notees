/**
 * E2EE kill-switch gate: workspace keying runs ONLY when
 * `window.NOTEES_CONFIG.e2ee === "on"`. With the flag absent (the default
 * until the sibling clients converge on the encrypted-fixture lockstep) a
 * connect makes NO key-route call at all and opens keyless — today's
 * behavior preserved byte-for-byte.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createKdfRecord, generateMasterKey } from "@notees/protocol";

import { clearCryptoCustody, deriveMasterKey } from "../src/core/crypto-custody.js";
import { resolveWorkspaceKey } from "../src/ui/app/store-connection.js";

const SERVER = "https://notees.example.com";
const TOKEN = "session-token";
const WS = "0192a000-0000-7000-8000-000000000001";
const PASSWORD = "correct horse battery staple";

async function masterInMemory(): Promise<void> {
  const master = await generateMasterKey();
  await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
}

afterEach(() => {
  clearCryptoCustody();
  vi.unstubAllGlobals();
  delete window.NOTEES_CONFIG;
});

describe("E2EE opt-in gate (NOTEES_CONFIG.e2ee)", () => {
  it("flag absent → keyless with NO key-route call, even with a master key in memory", async () => {
    await masterInMemory();
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called when the flag is absent");
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution.key).toBeUndefined();
    expect(resolution.locked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flag \"off\" → keyless with NO key-route call", async () => {
    await masterInMemory();
    window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: "off" };
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called when the flag is off");
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution.key).toBeUndefined();
    expect(resolution.locked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flag "on" + master key → establishes the workspace key via the key routes', async () => {
    window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: "on" };
    await masterInMemory();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      }
      if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution.key).toBeInstanceOf(Uint8Array);
    expect(resolution.key!.length).toBe(32);
    expect(resolution.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("flag \"on\" but offline → keyless (offline workspaces never key)", async () => {
    window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: "on" };
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

    expect(resolution.key).toBeUndefined();
    expect(resolution.locked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
