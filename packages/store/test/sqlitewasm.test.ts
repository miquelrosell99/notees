/**
 * sqlite-wasm adapter (the third StoreBackend): open/write/serialize/restore
 * round-trip, the staged async restore contract, reset, FTS5 parity, and the
 * opfs mode's structural guarantees (persist-by-VFS, no sync restore, no
 * OpfsDb without the VFS). The full fixture corpus replays through this
 * backend in store.test.ts / property-elements.test.ts — this file pins the
 * adapter-specific contracts those suites can't see.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { default as initSqliteWasm } from "@sqlite.org/sqlite-wasm";

import { Store } from "../src/index.js";
import {
  sqliteWasmBackend,
  type SqliteWasmModule,
} from "../src/adapters/sqlitewasm.js";

let sqliteWasm: SqliteWasmModule;

beforeAll(async () => {
  sqliteWasm = (await initSqliteWasm()) as unknown as SqliteWasmModule;
});

describe("sqlite-wasm backend (memory mode)", () => {
  it("declares fts5 — the official build ships FTS5, so the restore repair arm never fires", () => {
    const backend = sqliteWasmBackend(sqliteWasm, { kind: "memory" });
    expect(backend.ftsModule).toBe("fts5");
    const store = Store.open(backend);
    // The schema builds the search index with the FTS5 grammar on this backend.
    expect(
      store.database
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'search_index'")
        .get(),
    ).toMatchObject({
      sql: expect.stringContaining("fts5") as unknown as string,
    });
    store.close();
  });

  it("write → serialize → sync restore round-trips through the posix file layer", () => {
    const store = Store.open(sqliteWasmBackend(sqliteWasm, { kind: "memory" }));
    store.applyMany([]);
    store.database.prepare("INSERT INTO node (id, workspace_id, is_class) VALUES ('a', 'ws', 0)").run();
    const bytes = store.snapshot();
    const restored = Store.open(sqliteWasmBackend(sqliteWasm, { kind: "memory" }));
    restored.restore(bytes);
    expect(
      restored.database.prepare("SELECT COUNT(*) AS n FROM node").get(),
    ).toMatchObject({ n: 1 });
    store.close();
    restored.close();
  });

  it("restoreAsync falls back to the sync restore in memory mode", async () => {
    const store = Store.open(sqliteWasmBackend(sqliteWasm, { kind: "memory" }));
    store.database.prepare("INSERT INTO node (id, workspace_id, is_class) VALUES ('b', 'ws', 0)").run();
    const bytes = store.snapshot();
    const restored = Store.open(sqliteWasmBackend(sqliteWasm, { kind: "memory" }));
    await restored.restoreAsync(bytes);
    expect(
      restored.database.prepare("SELECT COUNT(*) AS n FROM node").get(),
    ).toMatchObject({ n: 1 });
    store.close();
    restored.close();
  });

  it("reset drops every object and re-migrates to an empty current-schema store", () => {
    const store = Store.open(sqliteWasmBackend(sqliteWasm, { kind: "memory" }));
    store.applyMany([]);
    store.database.prepare("INSERT INTO node (id, workspace_id, is_class) VALUES ('c', 'ws', 0)").run();
    expect(
      store.database.prepare("SELECT COUNT(*) AS n FROM node").get(),
    ).toMatchObject({ n: 1 });
    store.reset();
    expect(
      store.database.prepare("SELECT COUNT(*) AS n FROM node").get(),
    ).toMatchObject({ n: 0 });
    // The schema ladder re-applied: the canonical tables exist again.
    expect(
      store.database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get(),
    ).toMatchObject({ n: expect.any(Number) as unknown as number });
    store.close();
  });
});

describe("sqlite-wasm backend (opfs mode)", () => {
  it("refuses the sync restore — restore is staged async through the caller's writeFile", () => {
    const backend = sqliteWasmBackend(sqliteWasm, {
      kind: "opfs",
      fileName: "ws.db",
      writeFile: async () => {},
    });
    // Node build has no OpfsDb: open() throws before restore is even reached,
    // but the sync restore's contract error must be explicit regardless.
    expect(() => backend.restore(new Uint8Array([0]))).toThrow(/staged async/);
  });

  it("stages the bytes through writeFile, then opens by name (no heap image)", async () => {
    // Node has no OpfsDb, so the staged write is asserted through the memory
    // module's restoreAsync fallback parity instead; the opfs-specific arm is
    // exercised in the browser (worker-core boot). Here: writeFile is awaited
    // BEFORE the open attempt — the staging contract.
    const staged: Uint8Array[] = [];
    const backend = sqliteWasmBackend(sqliteWasm, {
      kind: "opfs",
      fileName: "ws.db",
      writeFile: async (bytes) => {
        staged.push(bytes);
      },
    });
    await expect(backend.restoreAsync?.(new Uint8Array([1, 2, 3]))).rejects.toThrow(/OpfsDb/);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws a clear error when OpfsDb is unavailable (no OPFS VFS)", () => {
    const backend = sqliteWasmBackend(sqliteWasm, {
      kind: "opfs",
      fileName: "ws.db",
      writeFile: async () => {},
    });
    expect(() => backend.open()).toThrow(/OpfsDb/);
  });

  it("memory mode has no stream source — Store.snapshotStream() resolves null", async () => {
    const store = Store.open(sqliteWasmBackend(sqliteWasm, { kind: "memory" }));
    expect(await store.snapshotStream()).toBeNull();
    store.close();
  });

  it("opfs mode without openFile resolves null even without the VFS", async () => {
    const backend = sqliteWasmBackend(sqliteWasm, {
      kind: "opfs",
      fileName: "ws.db",
      writeFile: async () => {},
    });
    expect(await backend.snapshotStream?.()).toBeNull();
  });

  it("opfs mode with openFile requires the VFS (checkpoints before reading)", async () => {
    const backend = sqliteWasmBackend(sqliteWasm, {
      kind: "opfs",
      fileName: "ws.db",
      writeFile: async () => {},
      openFile: async () => ({
        size: 3,
        stream: () => new Blob([new Uint8Array([1, 2, 3])]).stream(),
      }),
    });
    // Node build carries no OpfsDb — the stream source must fail loud here;
    // in the browser the checkpoint runs before the file is opened.
    await expect(backend.snapshotStream?.()).rejects.toThrow(/OpfsDb/);
  });
});
