/**
 * Master-key persistence tests (owner decision 2026-11-04): the derived
 * account master key is persisted in IndexedDB as a NON-EXTRACTABLE CryptoKey
 * handle so a reload within a signed-in session does not require re-unlocking.
 *
 * - deriveMasterKey persists the handle (bounded await: the fast-path write is
 *   done before derive resolves; a stall can never block past ~1s; one warning
 *   + one deferred retry on failure; never raw bytes on Chromium — Firefox
 *   refuses to clone a CryptoKey into IndexedDB, so it gets a raw-bytes
 *   record, restore re-imports it non-extractable).
 * - restoreMasterKeyFromStorage re-hydrates the slot after a reload.
 * - clearCryptoCustody deletes the record and drops the slot (sign-out).
 * - Wiring: a cold slot + a stored handle + a wrapped-key row opens UNLOCKED;
 *   no stored handle reports locked (existing banner path).
 *
 * fake-indexeddb is not a devDep, so the store seam takes an in-memory fake
 * (record-shaped, so the bytes↔key logic is exercised through it).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKdfRecord,
  generateMasterKey,
  generateWorkspaceKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from "@notees/protocol";

import {
  __clearMasterKeySlotForTests,
  clearCryptoCustody,
  currentMasterKey,
  deriveMasterKey,
  restoreMasterKeyFromStorage,
} from "../src/core/crypto-custody.js";
import {
  setMasterKeyStoreForTests,
  type MasterKeyRecord,
  type MasterKeyStore,
} from "../src/core/master-key-storage.js";
import { resolveWorkspaceKey } from "../src/ui/app/store-connection.js";

const SERVER = "https://notees.example.com";
const TOKEN = "session-token";
const WS = "0192a000-0000-7000-8000-000000000001";
const PASSWORD = "correct horse battery staple";

/** In-memory fake standing in for the IndexedDB record (preferred shape). */
function fakeStore(): MasterKeyStore & { record: MasterKeyRecord | null } {
  const state = { record: null as MasterKeyRecord | null };
  return {
    get record() {
      return state.record;
    },
    async store(record: MasterKeyRecord) {
      state.record = record;
    },
    async load() {
      return state.record === null ? null : { id: "masterKey", ...state.record };
    },
    async delete() {
      state.record = null;
    },
  };
}

/**
 * Firefox fake: refuses to structured-clone a CryptoKey (DataCloneError on
 * put, the live 2026-11-04 finding) and accepts the raw-bytes fallback.
 */
function firefoxStore(): {
  store: MasterKeyStore;
  state: { record: MasterKeyRecord | null; keyPuts: number; bytePuts: number };
} {
  const state = { record: null as MasterKeyRecord | null, keyPuts: 0, bytePuts: 0 };
  const store: MasterKeyStore = {
    async store(record: MasterKeyRecord) {
      if (record.key instanceof CryptoKey) {
        state.keyPuts += 1;
        throw new DOMException("could not be cloned", "DataCloneError");
      }
      state.bytePuts += 1;
      state.record = record;
    },
    async load() {
      return state.record === null ? null : { id: "masterKey", ...state.record };
    },
    async delete() {
      state.record = null;
    },
  };
  return { store, state };
}

async function deriveInto(store: MasterKeyStore): Promise<CryptoKey> {
  const master = await generateMasterKey();
  const kdf = await createKdfRecord(master, PASSWORD);
  await deriveMasterKey(PASSWORD, kdf);
  return master;
}

afterEach(async () => {
  await clearCryptoCustody();
  setMasterKeyStoreForTests(undefined);
  vi.unstubAllGlobals();
  delete window.NOTEES_CONFIG;
});

describe("master-key IndexedDB persistence", () => {
  it("deriveMasterKey persists the derived handle as a non-extractable CryptoKey", async () => {
    const store = fakeStore();
    setMasterKeyStoreForTests(store);

    await deriveInto(store);

    expect(store.record?.key).toBeInstanceOf(CryptoKey);
    expect(store.record!.key!.extractable).toBe(false);
  });

  it("restoreMasterKeyFromStorage re-hydrates the slot from the stored handle", async () => {
    const store = fakeStore();
    setMasterKeyStoreForTests(store);
    await deriveInto(store);
    const persisted = store.record!.key!;

    __clearMasterKeySlotForTests(); // simulate a reload (storage intact)
    expect(currentMasterKey()).toBeNull();

    await expect(restoreMasterKeyFromStorage()).resolves.toBe(true);
    expect(currentMasterKey()?.key).toBe(persisted); // same handle, no re-import
  });

  it("restore returns false when no record exists (fresh device / keyless account)", async () => {
    const store = fakeStore();
    setMasterKeyStoreForTests(store);

    await expect(restoreMasterKeyFromStorage()).resolves.toBe(false);
    expect(currentMasterKey()).toBeNull();
  });

  it("clearCryptoCustody deletes the record and drops the slot; restore then returns false", async () => {
    const store = fakeStore();
    setMasterKeyStoreForTests(store);
    await deriveInto(store);

    await clearCryptoCustody();

    expect(store.record).toBeNull();
    expect(currentMasterKey()).toBeNull();
    await expect(restoreMasterKeyFromStorage()).resolves.toBe(false);
  });

  it("reload wiring: cold slot + stored handle opens the workspace UNLOCKED", async () => {
    window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: "on" };
    const store = fakeStore();
    setMasterKeyStoreForTests(store);
    const master = await deriveInto(store);

    const workspaceKey = await generateWorkspaceKey();
    const wrapped = await wrapWorkspaceKey(master, workspaceKey);
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

    __clearMasterKeySlotForTests(); // reload
    await restoreMasterKeyFromStorage(); // the boot session-validation path

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });
    expect(resolution.key).toBeInstanceOf(Uint8Array);
    expect(resolution.key!.length).toBe(32);
    expect(resolution.locked).toBe(false);
  });

  it("reload wiring: no stored handle reports locked (keyed workspace, banner path)", async () => {
    window.NOTEES_CONFIG = { serverUrl: SERVER, e2ee: "on" };
    const store = fakeStore();
    setMasterKeyStoreForTests(store);
    const master = await generateMasterKey();

    const workspaceKey = await generateWorkspaceKey();
    const wrapped = await wrapWorkspaceKey(master, workspaceKey);
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

    __clearMasterKeySlotForTests(); // reload with NO stored handle

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });
    expect(resolution.key).toBeUndefined();
    expect(resolution.locked).toBe(true);
  });
});

describe("deriveMasterKey persistence hardening (bounded await + warning + retry)", () => {
  /** Deferred fake: the write records its initiation, then settles on the test's release. */
  function deferredStore(): {
    store: MasterKeyStore;
    state: { record: MasterKeyRecord | null; storeCalls: number };
    release: () => void;
  } {
    const state = { record: null as MasterKeyRecord | null, storeCalls: 0 };
    let releaseStore: (() => void) | null = null;
    const store: MasterKeyStore = {
      async store(record: MasterKeyRecord) {
        state.storeCalls += 1;
        await new Promise<void>((resolve) => {
          releaseStore = resolve;
        });
        state.record = record;
      },
      async load() {
        return state.record === null ? null : { id: "masterKey", ...state.record };
      },
      async delete() {
        state.record = null;
      },
    };
    return { store, state, release: () => releaseStore!() };
  }

  it("awaits the fast-path write: derive does not resolve before the store settles", async () => {
    const { store, state, release } = deferredStore();
    setMasterKeyStoreForTests(store);

    const master = await generateMasterKey();
    const kdf = await createKdfRecord(master, PASSWORD);
    const derivePromise = deriveMasterKey(PASSWORD, kdf);
    // Wait out the scrypt unwrap until the custody write has been initiated.
    for (let i = 0; i < 100 && state.storeCalls === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(state.storeCalls).toBe(1);
    expect(state.record).toBeNull(); // the write was initiated but is still pending

    let resolved = false;
    void derivePromise.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(resolved).toBe(false); // the bounded await: derive waits for the store

    release();
    await derivePromise;
    expect(state.record?.key).toBeInstanceOf(CryptoKey);
    expect(state.record!.key!.extractable).toBe(false);
  });

  it("a stalled store cannot block derive past the cap — warning logged, one deferred retry fires", async () => {
    const state = { record: null as MasterKeyRecord | null, storeCalls: 0 };
    const store: MasterKeyStore = {
      async store() {
        state.storeCalls += 1;
        await new Promise<void>(() => {}); // never settles
      },
      async load() {
        return state.record === null ? null : { id: "masterKey", ...state.record };
      },
      async delete() {
        state.record = null;
      },
    };
    setMasterKeyStoreForTests(store);
    const warnings: unknown[][] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });

    const master = await generateMasterKey();
    const kdf = await createKdfRecord(master, PASSWORD);
    await expect(deriveMasterKey(PASSWORD, kdf)).resolves.toBeDefined(); // the cap lets it through
    warnSpy.mockRestore();

    expect(state.storeCalls).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0]).includes("not persisted")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 25)); // the deferred retry macrotask
    expect(state.storeCalls).toBe(2); // the retry fired (never settles: silent, no second warning)
  });

  it("a rejecting store warns and never throws from derive; the retry's failure warns again", async () => {
    const state = { storeCalls: 0 };
    const store: MasterKeyStore = {
      async store() {
        state.storeCalls += 1;
        throw new Error("storage disabled (policy)");
      },
      async load() {
        return null;
      },
      async delete() {},
    };
    setMasterKeyStoreForTests(store);
    const warnings: unknown[][] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });

    const master = await generateMasterKey();
    const kdf = await createKdfRecord(master, PASSWORD);
    await expect(deriveMasterKey(PASSWORD, kdf)).resolves.toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 25)); // the deferred retry macrotask
    warnSpy.mockRestore();

    // key put fails → bytes fallback fails (one attempt) → the retry's bytes
    // put fails again: three store calls, two failure warnings.
    expect(state.storeCalls).toBe(3);
    expect(warnings).toHaveLength(2);
    for (const args of warnings) {
      expect(String(args[0])).toContain("not persisted");
    }
  });
});

describe("Firefox fallback (CryptoKey structured-clone refusal)", () => {
  it("a CryptoKey put refusal stores the raw-bytes record; restore re-imports a working non-extractable key", async () => {
    const { store, state } = firefoxStore();
    setMasterKeyStoreForTests(store);

    await deriveInto(store);

    expect(state.keyPuts).toBe(1); // the CryptoKey put was attempted…
    expect(state.bytePuts).toBe(1); // …refused (DataCloneError), the bytes landed instead
    expect(state.record?.key).toBeUndefined();
    expect(state.record?.keyBytes).toBeInstanceOf(Uint8Array);
    expect(state.record!.keyBytes!.length).toBe(32);

    // Restore: the bytes re-import NON-EXTRACTABLE and the key actually works
    // (wrap/unwrap usages — parity with the original unwrapMasterKey import).
    __clearMasterKeySlotForTests();
    await expect(restoreMasterKeyFromStorage()).resolves.toBe(true);
    const restored = currentMasterKey()!.key;
    expect(restored.extractable).toBe(false);
    const workspaceKey = await generateWorkspaceKey();
    const wrapped = await wrapWorkspaceKey(restored, workspaceKey);
    await expect(unwrapWorkspaceKey(restored, wrapped)).resolves.toBeDefined();
  });

  it("clearCryptoCustody removes a raw-bytes record too", async () => {
    const { store, state } = firefoxStore();
    setMasterKeyStoreForTests(store);
    await deriveInto(store);
    expect(state.record?.keyBytes).toBeInstanceOf(Uint8Array);

    await clearCryptoCustody();

    expect(state.record).toBeNull();
    expect(currentMasterKey()).toBeNull();
    await expect(restoreMasterKeyFromStorage()).resolves.toBe(false);
  });
});
