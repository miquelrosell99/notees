/**
 * Crypto-custody tests: the client-side key custody core.
 *
 * - deriveMasterKey unwraps the account master key (throws at the verifier
 *   on a wrong password — Review Focus 2).
 * - ensureWorkspaceKey: GET 404 → generate + wrap + PUT + return raw;
 *   GET 200 → unwrap + return raw; PUT failure throws clear; a wrapped key
 *   that does not open under the master key throws "wrong master key".
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKdfRecord,
  exportWorkspaceKey,
  generateMasterKey,
  generateWorkspaceKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from "@notees/protocol";

import {
  clearCryptoCustody,
  deriveMasterKey,
  ensureWorkspaceKey,
} from "../src/core/crypto-custody.js";

const SERVER = "https://notees.example.com";
const TOKEN = "session-token";
const WS = "0192a000-0000-7000-8000-000000000001";
const PASSWORD = "correct horse battery staple";

afterEach(() => {
  vi.unstubAllGlobals();
  clearCryptoCustody();
});

async function makeMaster(password = PASSWORD) {
  const master = await generateMasterKey();
  const kdf = await createKdfRecord(master, password);
  return { master, kdf };
}

describe("deriveMasterKey", () => {
  it("unwraps the kdf record; a wrong password throws at the verifier", async () => {
    const { kdf } = await makeMaster();
    await expect(deriveMasterKey(PASSWORD, kdf)).resolves.toBeDefined();
    await expect(deriveMasterKey("wrong password", kdf)).rejects.toThrow(/verifier|password/i);
  });
});

describe("ensureWorkspaceKey", () => {
  it("GET 404 → generates a key, PUTs it wrapped (openable under the master), returns the raw 32 bytes", async () => {
    const { master, kdf } = await makeMaster();
    const masterHandle = await deriveMasterKey(PASSWORD, kdf);

    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ method: init?.method ?? "GET", url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        if (url.endsWith(`/api/workspaces/${WS}/key`) && (init?.method ?? "GET") === "GET") {
          return Response.json({ error: { message: "not found" } }, { status: 404 });
        }
        if (url.endsWith(`/api/workspaces/${WS}/key`) && init?.method === "PUT") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    const raw = await ensureWorkspaceKey(SERVER, TOKEN, WS, masterHandle);
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(raw.length).toBe(32);

    // The PUT carried a wrapped key openable under the master key.
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put).toBeDefined();
    const wrapped = (put.body as { wrappedKey: string }).wrappedKey;
    const reopened = await unwrapWorkspaceKey(master, wrapped);
    expect([...(await exportWorkspaceKey(reopened))]).toEqual([...raw]);
  });

  it("GET 200 → returns the raw key equal to the stored wrapped one", async () => {
    const { master, kdf } = await makeMaster();
    const masterHandle = await deriveMasterKey(PASSWORD, kdf);
    const workspaceKey = await generateWorkspaceKey();
    const wrapped = await wrapWorkspaceKey(master, workspaceKey);
    const expectedRaw = await exportWorkspaceKey(workspaceKey);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/api/workspaces/${WS}/key`) && (init?.method ?? "GET") === "GET") {
          return Response.json({ wrappedKey: wrapped });
        }
        throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    const raw = await ensureWorkspaceKey(SERVER, TOKEN, WS, masterHandle);
    expect([...raw]).toEqual([...expectedRaw]);
  });

  it("PUT failure (403) throws with a clear error", async () => {
    const { master, kdf } = await makeMaster();
    const masterHandle = await deriveMasterKey(PASSWORD, kdf);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/api/workspaces/${WS}/key`) && (init?.method ?? "GET") === "GET") {
          return Response.json({ error: { message: "not found" } }, { status: 404 });
        }
        if (url.endsWith(`/api/workspaces/${WS}/key`) && init?.method === "PUT") {
          return Response.json({ error: { message: "forbidden" } }, { status: 403 });
        }
        throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    await expect(ensureWorkspaceKey(SERVER, TOKEN, WS, masterHandle)).rejects.toThrow(/forbidden|403/i);
  });

  it("a stored key that does not open under the master throws 'wrong master key for this workspace'", async () => {
    const { master, kdf } = await makeMaster();
    const masterHandle = await deriveMasterKey(PASSWORD, kdf);
    // Wrapped under a DIFFERENT master.
    const otherMaster = await generateMasterKey();
    const workspaceKey = await generateWorkspaceKey();
    const wrapped = await wrapWorkspaceKey(otherMaster, workspaceKey);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/api/workspaces/${WS}/key`) && (init?.method ?? "GET") === "GET") {
          return Response.json({ wrappedKey: wrapped });
        }
        throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    await expect(ensureWorkspaceKey(SERVER, TOKEN, WS, masterHandle)).rejects.toThrow(
      /wrong master key for this workspace/i,
    );
  });
});

describe("ensureWorkspaceKey first-write-wins race", () => {
  it("two concurrent flights for the same workspace share ONE flight and resolve to the same key", async () => {
    const { master, kdf } = await makeMaster();
    const masterHandle = await deriveMasterKey(PASSWORD, kdf);

    let stored: string | null = null;
    let putCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
          return stored === null
            ? Response.json({ error: { message: "not found" } }, { status: 404 })
            : Response.json({ wrappedKey: stored });
        }
        if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "PUT") {
          putCount += 1;
          if (stored !== null) {
            return Response.json(
              { error: { message: "a workspace key already exists" } },
              { status: 409 },
            );
          }
          stored = (JSON.parse(String(init!.body)) as { wrappedKey: string }).wrappedKey;
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    const [first, second] = await Promise.all([
      ensureWorkspaceKey(SERVER, TOKEN, WS, masterHandle),
      ensureWorkspaceKey(SERVER, TOKEN, WS, masterHandle),
    ]);

    expect([...first]).toEqual([...second]);
    expect(putCount).toBe(1); // in-flight dedupe: one PUT, not a racing pair
  });

  it("a PUT 409 adopts the winner's stored key (re-GET + unwrap under the master)", async () => {
    const { master, kdf } = await makeMaster();
    const masterHandle = await deriveMasterKey(PASSWORD, kdf);
    const winnerKey = await generateWorkspaceKey();
    const winnerWrapped = await wrapWorkspaceKey(master, winnerKey);
    const expectedRaw = await exportWorkspaceKey(winnerKey);

    // A concurrent device already stored its key; the client's FIRST GET is
    // the racy read that still sees 404, so it generates and loses the PUT
    // race (409) — it must then re-GET and adopt the winner's key.
    let firstGet = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
          if (firstGet) {
            firstGet = false;
            return Response.json({ error: { message: "not found" } }, { status: 404 });
          }
          return Response.json({ wrappedKey: winnerWrapped });
        }
        if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "PUT") {
          return Response.json(
            { error: { message: "a workspace key already exists" } },
            { status: 409 },
          );
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    const raw = await ensureWorkspaceKey(SERVER, TOKEN, WS, masterHandle);
    expect([...raw]).toEqual([...expectedRaw]);
  });

  it("a PUT 409 whose stored key does NOT open under the master throws the wrong-master error (a real error state)", async () => {
    const { master, kdf } = await makeMaster();
    const masterHandle = await deriveMasterKey(PASSWORD, kdf);
    const otherMaster = await generateMasterKey();
    const winnerKey = await generateWorkspaceKey();
    const winnerWrapped = await wrapWorkspaceKey(otherMaster, winnerKey);

    let stored: string | null = null;
    let putCount = 0;
    let firstGet = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
          if (firstGet) {
            firstGet = false;
            return Response.json({ error: { message: "not found" } }, { status: 404 });
          }
          return Response.json({ wrappedKey: winnerWrapped });
        }
        if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "PUT") {
          putCount += 1;
          return Response.json(
            { error: { message: "a workspace key already exists" } },
            { status: 409 },
          );
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    await expect(ensureWorkspaceKey(SERVER, TOKEN, WS, masterHandle)).rejects.toThrow(
      /wrong master key for this workspace/i,
    );
  });
});
