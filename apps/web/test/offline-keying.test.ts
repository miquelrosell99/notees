/**
 * Offline bootstrap keys at rest (Task 9): the "Work offline" local-only
 * workspace is keyed at CREATION (deliberate creation-time keying — there is
 * no server, so this is not the open-time keying the no-auto-key ruling
 * forbids). The device-local key lives in IndexedDB beside the master-key
 * record (DB `notees-custody`, store `workspaceKeys`, `{ id: <workspaceId>,
 * key?|keyBytes? }` — the same Chromium-non-extractable-handle /
 * Firefox-raw-bytes pattern), so a second offline open restores the SAME key
 * and content sealed with it still opens. Opened ONLINE against a server that
 * has never seen it (the key route 404s), the open pauses on the F2 adoption
 * OFFER — publish under the existing id, wrapping THE device key (publish,
 * not mint) — instead of a bare refusal or a silent auto-publish (see
 * `adoption-offer.test.tsx` for the confirm/fallback pins).
 *
 * Custody records survive sign-out: the offline workspace has no account,
 * and each key protects content sealed under it (wire/outbox envelopes), so
 * `clearCryptoCustody` (session end) must NOT orphan its sealed content
 * (the T9 data-availability ruling — F1 cleanup rides workspace removal
 * only, see `workspace-key-custody-cleanup.test.tsx`).
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
import { setLocalStoreContentProbeForTests } from "../src/ui/app/local-store-content.js";
import {
  AdoptionOfferError,
  confirmWorkspaceAdoption,
  resolveWorkspaceKey,
} from "../src/ui/app/store-connection.js";

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
  const state = { wrapped: undefined as string | undefined, gets: 0, puts: 0, posts: 0, bodies: [] as unknown[], postBodies: [] as Array<{ id?: string; wrappedKey?: string }> };
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
    if (url === `${SERVER}/api/workspaces` && method === "POST") {
      state.posts += 1;
      state.postBodies.push(JSON.parse(String(init?.body)));
      const body = state.postBodies.at(-1)!;
      state.wrapped = body.wrappedKey;
      return Response.json({ id: body.id ?? WS }, { status: 201 });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { state, fetchMock };
}

afterEach(async () => {
  await clearCryptoCustody();
  setWorkspaceKeyStoreForTests(undefined);
  setLocalStoreContentProbeForTests(undefined);
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

describe("online open of an offline-created workspace (the F2 adoption offer)", () => {
  it("404 + custody + NON-EMPTY → the open pauses on the offer: no PUT, no POST, no key", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    await ensureOfflineWorkspaceKey(WS);
    const { state, fetchMock } = keyRouteWithPut();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    const failure = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdoptionOfferError);
    // Detection is read-only: exactly the key GET — no write of any kind.
    expect(state.gets).toBe(1);
    expect(state.puts).toBe(0);
    expect(state.posts).toBe(0);
  });

  it("empty local store → no offer: plaintext keyless open (nothing to publish)", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    await ensureOfflineWorkspaceKey(WS);
    const { state, fetchMock } = keyRouteWithPut();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => false);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution).toEqual({ key: undefined, locked: false, plaintext: true });
    expect(state.puts).toBe(0);
    expect(state.posts).toBe(0);
  });

  it("declinedAdoption → plaintext open, zero writes", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    await ensureOfflineWorkspaceKey(WS);
    const { state, fetchMock } = keyRouteWithPut();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
      declinedAdoption: true,
    });

    expect(resolution).toEqual({ key: undefined, locked: false, plaintext: true });
    expect(state.puts).toBe(0);
    expect(state.posts).toBe(0);
  });

  it("confirm publishes via POST (existing id, THE device key's wrap); the second open rides GET 200 — no second offer, no PUT", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    const handle = await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    const deviceKey = await ensureOfflineWorkspaceKey(WS);
    const { state, fetchMock } = keyRouteWithPut();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    await expect(
      resolveWorkspaceKey(SERVER, TOKEN, WS, {
        isOffline: false,
        credentialType: "session",
        label: "Workspace",
      }),
    ).rejects.toBeInstanceOf(AdoptionOfferError);

    await confirmWorkspaceAdoption(SERVER, TOKEN, WS, "Workspace");
    expect(state.posts).toBe(1);
    expect(state.puts).toBe(0);
    // The wrap opens under the master to THE DEVICE KEY (publish, not mint).
    const posted = state.postBodies[0]!;
    expect(posted.id).toBe(WS);
    const unwrapped = await unwrapWorkspaceKey(handle.key, posted.wrappedKey!);
    expect(await exportWorkspaceKey(unwrapped)).toEqual(deviceKey);

    // Next open: the server holds the wrap — the plain read path serves it;
    // no second offer, no second upload.
    const second = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });
    expect(second.key).toEqual(deviceKey);
    expect(second.locked).toBe(false);
    expect(state.posts).toBe(1);
    expect(state.puts).toBe(0);
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
    expect(state.posts).toBe(0);
  });
});
