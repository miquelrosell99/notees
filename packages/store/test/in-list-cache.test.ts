/**
 * Dynamic IN-list statement shapes (review minor 8): the appliers build
 * `IN (${placeholders})` SQL with one prepared-statement cache key per
 * distinct list length — past the adapter's 1000-entry cache cap the map
 * clear/rebuild cycles. These pins drive subtree operations across many
 * distinct sizes and assert each statement template prepares only the
 * canonical ladder shapes (padded chunks), plus that subtrees past the
 * chunk max still execute correctly (chunked execution).
 */

import { describe, expect, it } from "vitest";

import { newEnvelope } from "@notees/protocol";

import { IN_CHUNK_LADDER, type SqliteDB, type SqliteStatement, type StoreBackend } from "../src/db.js";
import { Store } from "../src/store.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";

/** Backend wrapper recording every distinct SQL string handed to prepare. */
function countingBackend(base: StoreBackend, seen: Set<string>): StoreBackend {
  const wrapDb = (db: SqliteDB): SqliteDB => ({
    exec: (sql) => db.exec(sql),
    prepare: (sql: string): SqliteStatement => {
      seen.add(sql);
      return db.prepare(sql);
    },
    pragma: (source, options) => db.pragma(source, options),
    transaction: (fn) => db.transaction(fn),
    ...(db.serialize !== undefined ? { serialize: db.serialize.bind(db) } : {}),
    ...(db.close !== undefined ? { close: db.close.bind(db) } : {}),
  });
  return {
    ftsModule: base.ftsModule,
    open: () => wrapDb(base.open()),
    restore: (bytes) => wrapDb(base.restore(bytes)),
    ...(base.restoreAsync !== undefined
      ? { restoreAsync: async (bytes: Uint8Array) => wrapDb(await base.restoreAsync!(bytes)) }
      : {}),
    ...(base.snapshotStream !== undefined ? { snapshotStream: base.snapshotStream.bind(base) } : {}),
    reset: () => wrapDb(base.reset()),
  };
}

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
let clock = 1727200000000;

function id(n: number): string {
  return `0192b000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

function env(opType: string, payload: Record<string, unknown>): unknown {
  clock += 7;
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "in-list-test",
    hlc: { physical: clock, logical: 0 },
    opType,
    payload,
    timestamp: new Date(clock).toISOString(),
  });
}

const createNode = (objectId: string, parentId?: string) =>
  env("object.create", {
    objectId,
    ...(parentId !== undefined ? { parentId } : {}),
    contentAst: [{ type: "text", text: `node ${objectId}` }],
  });

/** Distinct prepared shapes for statements whose SQL contains `needle`. */
function shapesOf(seen: Set<string>, needle: string): string[] {
  return [...seen].filter((sql) => sql.includes(needle));
}

describe("dynamic IN-list statement shapes", () => {
  it("permanent-delete cascades prepare only canonical ladder shapes across subtree sizes", () => {
    const seen = new Set<string>();
    const store = new Store(countingBackend(betterSqlite3Backend(":memory:"), seen));
    // Thirty roots with subtree sizes 1..30 (root plus k children).
    for (let k = 0; k < 30; k += 1) {
      store.apply(createNode(id(k)));
      for (let c = 1; c <= k; c += 1) {
        store.apply(createNode(id(k * 1000 + c), id(k)));
      }
    }
    for (let k = 0; k < 30; k += 1) {
      store.apply(env("object.delete", { objectId: id(k), permanent: true }));
    }
    // One cache key per distinct length would be ~30 shapes per template;
    // the ladder bounds each template to at most one shape per rung.
    expect(shapesOf(seen, "DELETE FROM node WHERE id IN (").length).toBeLessThanOrEqual(
      IN_CHUNK_LADDER.length,
    );
    expect(shapesOf(seen, "DELETE FROM node_child_order WHERE parent_id IN (").length).toBeLessThanOrEqual(
      IN_CHUNK_LADDER.length,
    );
    expect(shapesOf(seen, "DELETE FROM node_stats WHERE node_id IN (").length).toBeLessThanOrEqual(
      IN_CHUNK_LADDER.length,
    );
  });

  it("soft delete and restore prepare only canonical ladder shapes across subtree sizes", () => {
    const seen = new Set<string>();
    const store = new Store(countingBackend(betterSqlite3Backend(":memory:"), seen));
    for (let k = 0; k < 30; k += 1) {
      store.apply(createNode(id(100_000 + k)));
      for (let c = 1; c <= k; c += 1) {
        store.apply(createNode(id(100_000 + k * 1000 + c), id(100_000 + k)));
      }
    }
    for (let k = 0; k < 30; k += 1) {
      store.apply(env("object.delete", { objectId: id(100_000 + k), permanent: false }));
    }
    expect(shapesOf(seen, "UPDATE node SET is_active = 0 WHERE id IN (").length).toBeLessThanOrEqual(
      IN_CHUNK_LADDER.length,
    );
    for (let k = 0; k < 30; k += 1) {
      store.apply(env("object.restore", { objectId: id(100_000 + k) }));
    }
    expect(shapesOf(seen, "UPDATE node SET is_active = 1 WHERE id IN (").length).toBeLessThanOrEqual(
      IN_CHUNK_LADDER.length,
    );
    // And the trees really are back.
    const nodes = (
      store.database.prepare("SELECT COUNT(*) AS n FROM node WHERE is_active = 1").get() as {
        n: number;
      }
    ).n;
    expect(nodes).toBe(30 + (29 * 30) / 2);
  });

  it("subtrees past the chunk max delete and restore correctly (chunked execution)", () => {
    const store = new Store(betterSqlite3Backend(":memory:"));
    const CHILDREN = 950; // past the 900 chunk max
    store.apply(createNode(id(900_000)));
    const batch: unknown[] = [];
    for (let c = 1; c <= CHILDREN; c += 1) {
      batch.push(createNode(id(900_000 + c), id(900_000)));
    }
    store.applyMany(batch);
    store.apply(env("object.delete", { objectId: id(900_000), permanent: false }));
    expect(
      (store.database.prepare("SELECT COUNT(*) AS n FROM node WHERE is_active = 1").get() as { n: number }).n,
    ).toBe(0);
    store.apply(env("object.restore", { objectId: id(900_000) }));
    expect(
      (store.database.prepare("SELECT COUNT(*) AS n FROM node WHERE is_active = 1").get() as { n: number }).n,
    ).toBe(CHILDREN + 1);
    // Permanent delete past the chunk max purges the whole subtree.
    store.apply(env("object.delete", { objectId: id(900_000), permanent: true }));
    expect(
      (store.database.prepare("SELECT COUNT(*) AS n FROM node").get() as { n: number }).n,
    ).toBe(0);
  });
});
