/**
 * Offline bootstrap keys at rest (Task 9): the "Work offline" local-only
 * workspace is keyed at CREATION (deliberate creation-time keying — there is
 * no server, so this is not the open-time keying the no-auto-key ruling
 * forbids). The device-local key lives in IndexedDB beside the master-key
 * record (DB `notees-custody`, store `workspaceKeys`, `{ id: <workspaceId>,
 * key?|keyBytes? }` — the same Chromium-non-extractable-handle /
 * Firefox-raw-bytes pattern), so a second offline open restores the SAME key
 * and content sealed with it still opens. On the FIRST password-session sync
 * (the offline workspace later opened online with the master key in memory)
 * the client uploads the wrap under the master — publishing the EXISTING
 * key's wrap, never generating one on open.
 *
 * Custody records survive sign-out: the offline workspace has no account, so
 * `clearCryptoCustody` (session end) must NOT orphan its sealed content.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKdfRecord,
  exportWorkspaceKey,
  generateMasterKey,
  importWorkspaceKey,
  unwrapWorkspaceKey,
} from "@notees/protocol";

import {
  clearCryptoCustody,
  currentMasterKey,
  deriveMasterKey,
  ensureOfflineWorkspaceKey,
} from "../src/core/crypto-custody.js";
import {
  getOfflineWorkspaceKey,
  persistOfflineWorkspaceKey,
  setWorkspaceKeyStoreForTests,
  type WorkspaceKeyRecord,
  type WorkspaceKeyStore,
} from "../src/core/master-key-storage.js";
import { resolveWorkspaceKey } from "../src/ui/app/store-connection.js";

const SERVER = "https://notees.example.com";
const TOKEN = "session-token";
const WS = "0192a000-0000-7000-8000-000000000001";
const PASSWORD = "correct horse battery staple";

/** In-memory fake standing in for the IndexedDB workspace-key record. */
function fakeStore(): WorkspaceKeyStore & { record: WorkspaceKeyRecord | null } {
  const state = { record: null as WorkspaceKeyRecord | null };
  return {
    get record() {
      return state.record;
    },
    async store(id, record) {
      state.record = record;
      void id;
    },
    async load() {
      return state.record === null ? null : { id: WS, ...state.record };
    },
    async delete() {
      state.record = null;
    },
  };
}

/**
 * Firefox fake: refuses to structured-clone a CryptoKey (DataCloneError on
 * put — the live 2026-11-04 finding) and accepts the raw-bytes fallback.
 */
function firefoxStore(): {
  store: WorkspaceKeyStore;
  state: { record: WorkspaceKeyRecord | null; keyPuts: number; bytePuts: number };
} {
  const state = { record: null as WorkspaceKeyRecord | null, keyPuts: 0, bytePuts: 0 };
  const store: WorkspaceKeyStore = {
    async store(id, record) {
      if (record.key instanceof CryptoKey) {
        state.keyPuts += 1;
        throw new DOMException("could not be cloned", "DataCloneError");
      }
      state.bytePuts += 1;
      state.record = record;
      void id;
    },
    async load() {
      return state.record === null ? null : { id: WS, ...state.record };
    },
    async delete() {
      state.record = null;
    },
  };
  return { store, state };
}

/** Fetch router over a stateful key route: GET 404 while no wrap is stored, PUT stores one. */
function keyRouteWithPut() {
  const state = { wrapped: undefined as string | undefined, gets: 0, puts: 0, bodies: [] as unknown[] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
      state.gets += 1;
      if (state.wrapped === undefined) {
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      }
      return Response.json({ wrappedKey: state.wrapped });
    }
    if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "PUT") {
      state.puts += 1;
      state.bodies.push(JSON.parse(String(init?.body)));
      state.wrapped = (state.bodies[0] as { wrappedKey: string }).wrappedKey;
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { state, fetchMock };
}

afterEach(async () => {
  await clearCryptoCustody();
  setWorkspaceKeyStoreForTests(undefined);
  vi.unstubAllGlobals();
  delete window.NOTEES_CONFIG;
});

describe("offline workspace-key custody (device-local, no account)", () => {
  it("persistOfflineWorkspaceKey + getOfflineWorkspaceKey round-trip the same key", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const key = await importWorkspaceKey(crypto.getRandomValues(new Uint8Array(32)));

    await persistOfflineWorkspaceKey(WS, key);

    expect(store.record?.key).toBeInstanceOf(CryptoKey);
    const restored = await getOfflineWorkspaceKey(WS);
    expect(restored).not.toBeNull();
    expect(await exportWorkspaceKey(restored!)).toEqual(await exportWorkspaceKey(key));
  });

  it("the first offline open generates + persists a key; a second open restores the SAME key", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);

    const first = await ensureOfflineWorkspaceKey(WS);
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first.length).toBe(32);
    expect(first.some((b) => b !== 0)).toBe(true);
    expect(store.record?.key).toBeInstanceOf(CryptoKey);

    // A second open (new "session", custody intact) restores the same key —
    // content sealed with it still opens.
    const second = await ensureOfflineWorkspaceKey(WS);
    expect(second).toEqual(first);
  });

  it("Firefox fallback: a CryptoKey put refusal stores raw bytes; restore re-imports a working key", async () => {
    const { store, state } = firefoxStore();
    setWorkspaceKeyStoreForTests(store);

    const first = await ensureOfflineWorkspaceKey(WS);

    expect(state.keyPuts).toBe(1); // the CryptoKey put was attempted…
    expect(state.bytePuts).toBe(1); // …refused, the bytes landed instead
    expect(state.record?.key).toBeUndefined();
    expect(state.record?.keyBytes).toBeInstanceOf(Uint8Array);
    expect(state.record!.keyBytes!.length).toBe(32);

    const restored = await getOfflineWorkspaceKey(WS);
    expect(restored).not.toBeNull();
    expect(await exportWorkspaceKey(restored!)).toEqual(first);
  });

  it("a persist failure warns and still returns a session key (the content seals this session)", async () => {
    const store: WorkspaceKeyStore = {
      async store() {
        throw new Error("storage disabled (policy)");
      },
      async load() {
        return null;
      },
      async delete() {},
    };
    setWorkspaceKeyStoreForTests(store);
    const warnings: unknown[][] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });

    const key = await ensureOfflineWorkspaceKey(WS);
    warnSpy.mockRestore();

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(String(warnings[0]![0])).toContain("offline workspace key");
  });

  it("sign-out (clearCryptoCustody) does NOT orphan the offline workspace key", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    const first = await ensureOfflineWorkspaceKey(WS);

    await clearCryptoCustody(); // session end: master record deleted

    expect(store.record?.key).toBeInstanceOf(CryptoKey); // the workspace key survives
    expect(await ensureOfflineWorkspaceKey(WS)).toEqual(first);
  });
});

describe("offline open restores the custody key (resolveWorkspaceKey offline arm)", () => {
  it("custody holds the key → restores it, locked impossible, no network", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const deviceKey = await ensureOfflineWorkspaceKey(WS);
    const fetchMock = vi.fn(async () => {
      throw new Error("offline connect must not touch the network");
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, "", WS, {
      isOffline: true,
      credentialType: "session",
      label: "This device (offline)",
    });

    expect(resolution.key).toEqual(deviceKey);
    expect(resolution.locked).toBe(false);
    expect(resolution.plaintext).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("empty custody → keyless but NOT locked and NOT plaintext (indeterminate), no network", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const fetchMock = vi.fn(async () => {
      throw new Error("offline connect must not touch the network");
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, "", WS, {
      isOffline: true,
      credentialType: "session",
      label: "This device (offline)",
    });

    expect(resolution).toEqual({ key: undefined, locked: false, plaintext: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("first password-session sync uploads the wrap under the master", () => {
  it("online 404 + a custody device key → exactly one PUT wrapping THE device key; the open is sealed with it", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    const deviceKey = await ensureOfflineWorkspaceKey(WS);
    const { state, fetchMock } = keyRouteWithPut();
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    // The open rides the device key — the local sealed content stays readable.
    expect(resolution.key).toEqual(deviceKey);
    expect(resolution.locked).toBe(false);
    expect(resolution.plaintext).toBe(false);
    // Exactly one wrap upload on the first sync.
    expect(state.gets).toBe(1);
    expect(state.puts).toBe(1);
    // The wrap opens under the master to THE DEVICE KEY (publish, not mint).
    const wrapped = (state.bodies[0] as { wrappedKey: string }).wrappedKey;
    const unwrapped = await unwrapWorkspaceKey(currentMasterKey()!.key, wrapped);
    expect(await exportWorkspaceKey(unwrapped)).toEqual(deviceKey);
  });

  it("the second online open rides the server flow (GET 200, unwrap, NO second PUT)", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    const handle = await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    const deviceKey = await ensureOfflineWorkspaceKey(WS);
    const { state, fetchMock } = keyRouteWithPut();
    vi.stubGlobal("fetch", fetchMock);

    await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });
    expect(state.puts).toBe(1);

    // Next session: the server holds the wrap — the plain read path serves it.
    const second = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });
    expect(second.key).toEqual(deviceKey);
    expect(second.locked).toBe(false);
    expect(state.puts).toBe(1); // no second upload
    // The stored wrap really is openable under this master (server flow).
    const unwrapped = await unwrapWorkspaceKey(handle.key, state.wrapped!);
    expect(await exportWorkspaceKey(unwrapped)).toEqual(deviceKey);
  });

  it("a failed wrap upload does not block the open: local-first, the upload retries next session", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    const deviceKey = await ensureOfflineWorkspaceKey(WS);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      }
      if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "PUT") {
        return Response.json({ error: { message: "relay busy" } }, { status: 500 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution.key).toEqual(deviceKey);
    expect(resolution.locked).toBe(false);
  });

  it("no custody device key + online 404 → plaintext, keyless, NO PUT (the no-auto-key ruling holds)", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    const { state, fetchMock } = keyRouteWithPut();
    vi.stubGlobal("fetch", fetchMock);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution).toEqual({ key: undefined, locked: false, plaintext: true });
    expect(state.puts).toBe(0);
  });
});
