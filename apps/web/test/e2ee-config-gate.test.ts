/**
 * The E2EE kill switch is retired: workspace keying is UNCONDITIONAL.
 * `window.NOTEES_CONFIG.e2ee` stays typed for container compat but is inert —
 * absent, "off", or "on", a connect with a master key in memory resolves the
 * workspace key through the key routes (404 → generate + wrap + PUT), and
 * offline still short-circuits keyless (no server → no keys → plaintext).
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

/** The 404 → generate + wrap + PUT key-route stub shared by the matrix. */
function keyRouteStub() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
  ])("flag %s + master key → establishes the workspace key via the key routes", async (_label, flag) => {
    if (flag !== undefined) window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: flag };
    await masterInMemory();
    const fetchMock = keyRouteStub();
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

    expect(resolution.key).toBeUndefined();
    expect(resolution.locked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
