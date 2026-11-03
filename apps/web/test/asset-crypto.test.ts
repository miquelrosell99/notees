// @vitest-environment node
/**
 * Asset-byte sealing tests (plan 05): seal at upload when keyed, open at
 * download when sealed; keyless is legal both directions (plaintext
 * passthrough); sealed-without-key throws the honest locked error; decrypt
 * failure never yields corrupted bytes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  b64uDecode,
  b64uEncode,
  createKdfRecord,
  generateMasterKey,
  generateWorkspaceKey,
  wrapWorkspaceKey,
} from "@notees/protocol";

import {
  clearCryptoCustody,
  currentMasterKey,
  deriveMasterKey,
  ensureWorkspaceKey,
} from "../src/core/crypto-custody.js";
import {
  AssetSealedLockedError,
  openAssetIfSealed,
  sealAssetIfKeyed,
} from "../src/core/workspace-client/asset-crypto.js";

const SERVER = "https://notees.example.com";
const TOKEN = "session-token";
const WS = "0192a000-0000-7000-8000-000000000001";
const PASSWORD = "correct horse battery staple";
const BYTES = new Uint8Array([0, 1, 2, 250, 251, 252, 7, 8, 9]);

/** Seed custody: a master key + a cached workspace key (fetch 404 → PUT). */
async function seedKeyedWorkspace(): Promise<void> {
  const master = await generateMasterKey();
  const kdf = await createKdfRecord(master, PASSWORD);
  const handle = await deriveMasterKey(PASSWORD, kdf);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      }
      if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  await ensureWorkspaceKey(SERVER, TOKEN, WS, handle);
  vi.unstubAllGlobals();
}

afterEach(() => {
  clearCryptoCustody();
  vi.unstubAllGlobals();
});

describe("sealAssetIfKeyed", () => {
  it("keyed: seals with an external iv + declared fields (blob = tag ‖ ct)", async () => {
    await seedKeyedWorkspace();
    const sealed = await sealAssetIfKeyed(SERVER, TOKEN, WS, BYTES, "image/jpeg");
    expect(sealed.fields).toEqual({
      encrypted: "1",
      mimeType: "image/jpeg",
      iv: expect.stringMatching(/^[A-Za-z0-9_-]+$/) as unknown as string,
    });
    expect(b64uDecode(sealed.fields!.iv).length).toBe(12);
    expect(sealed.bytes.length).toBe(16 + BYTES.length);
    expect([...sealed.bytes]).not.toEqual([...BYTES]);
  });

  it("keyless: passthrough bytes, no fields", async () => {
    expect(currentMasterKey()).toBeNull();
    const sealed = await sealAssetIfKeyed(SERVER, TOKEN, WS, BYTES, "image/jpeg");
    expect(sealed.fields).toBeNull();
    expect([...sealed.bytes]).toEqual([...BYTES]);
  });
});

describe("openAssetIfSealed", () => {
  it("round-trips what sealAssetIfKeyed produced", async () => {
    await seedKeyedWorkspace();
    const sealed = await sealAssetIfKeyed(SERVER, TOKEN, WS, BYTES, "image/jpeg");
    const opened = await openAssetIfSealed(WS, sealed.fields!.iv, sealed.bytes);
    expect([...opened]).toEqual([...BYTES]);
  });

  it("plaintext (iv null) passes through unchanged", async () => {
    const opened = await openAssetIfSealed(WS, null, BYTES);
    expect([...opened]).toEqual([...BYTES]);
  });

  it("sealed without a key throws the honest locked error (fallback chip, never a render)", async () => {
    await seedKeyedWorkspace();
    const sealed = await sealAssetIfKeyed(SERVER, TOKEN, WS, BYTES, "image/jpeg");
    clearCryptoCustody(); // simulate the locked session
    await expect(openAssetIfSealed(WS, sealed.fields!.iv, sealed.bytes)).rejects.toBeInstanceOf(
      AssetSealedLockedError,
    );
  });

  it("a wrong cached key fails loud with a decryption error", async () => {
    await seedKeyedWorkspace();
    const sealed = await sealAssetIfKeyed(SERVER, TOKEN, WS, BYTES, "image/jpeg");
    // Re-key the workspace under a DIFFERENT master (password changed elsewhere).
    const otherMaster = await generateMasterKey();
    const otherKdf = await createKdfRecord(otherMaster, "other password");
    const otherHandle = await deriveMasterKey("other password", otherKdf);
    const otherWorkspaceKey = await generateWorkspaceKey();
    const otherWrapped = await wrapWorkspaceKey(otherMaster, otherWorkspaceKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ wrappedKey: otherWrapped })),
    );
    await ensureWorkspaceKey(SERVER, TOKEN, WS, otherHandle);
    await expect(
      openAssetIfSealed(WS, sealed.fields!.iv, sealed.bytes),
    ).rejects.toThrow(/decryption failed/i);
  });
});
