/**
 * External-id mappings for importer/sync plugins (owner requirement
 * 2026-10-23 — the plugin mapping substrate): the `external_ref.*` op
 * family, a durable per-workspace `externalId -> nodeId` map carried by
 * the log (Google Calendar event UID / Readwise highlight id / read-it-later
 * entry id -> the notees node uuid), so re-runs update instead of
 * duplicating.
 *
 *  - external_ref.set upserts one LIVE mapping per ref, LWW by the full
 *    (hlc, actor) tuple on the ref key — a re-set MOVES the mapping, a
 *    racing pair converges on the higher tuple under either delivery order.
 *  - external_ref.delete keeps a tombstone per ref (the
 *    property_value_tombstone precedent), INCLUDING a delete of an unmapped
 *    ref — the tombstone is what kills a stale concurrent set delivered
 *    later, so wipe -> replay converges under any order.
 *  - A node may carry MANY refs; the reverse read scans by node_id.
 *  - No referential integrity (the property_value precedent): a mapping may
 *    name a node another device has not synced yet.
 *  - A node's HARD delete purges its live rows (the subtreeIds pattern);
 *    soft-trash keeps them (a restore re-activates the node, mappings
 *    intact).
 *
 * Runs against BOTH shipped adapters, like the main store suite.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { EnvelopeValidationError, Store, type StoreBackend } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const ACTOR_PHONE = "0192a000-0000-7000-8000-000000000003";

const NODE_A = "0192a000-0000-7000-8000-000000000010";
const NODE_B = "0192a000-0000-7000-8000-000000000011";
const NODE_C = "0192a000-0000-7000-8000-000000000012";

const REF_GCAL = "gcal:event:abc123@google.com";
const REF_READWISE = "readwise:highlight:12345";
const REF_READITLATER = "readitlater:entry:7788";

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
  logical = 0,
  actor = ACTOR,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: actor,
    deviceId: "test-device-external-ref",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

function createPage(id: string, physical: number): Envelope {
  return env("object.create", { objectId: id }, physical);
}

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const adapters: { name: string; makeBackend: () => StoreBackend }[] = [
  { name: "sqljs", makeBackend: () => sqljsBackend(sqlModule) },
  {
    name: "better-sqlite3",
    makeBackend: () => {
      const dir = mkdtempSync(join(tmpdir(), "notees-external-ref-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

for (const adapter of adapters) {
  describe(`external_ref on ${adapter.name}`, () => {
    it("set resolves through resolveExternalRef; many refs ride one node; the reverse read is sorted", () => {
      const store = Store.open(adapter.makeBackend());
      store.applyMany([createPage(NODE_A, 1727200001000), createPage(NODE_B, 1727200001100)]);
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBeNull();
      expect(store.externalRefsOf(WS, NODE_A)).toEqual([]);

      store.apply(env("external_ref.set", { ref: REF_READWISE, nodeId: NODE_A }, 1727200002000));
      store.apply(
        env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_A }, 1727200002100),
      );
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBe(NODE_A);
      expect(store.resolveExternalRef(WS, REF_READWISE)).toBe(NODE_A);
      expect(store.externalRefsOf(WS, NODE_A)).toEqual([REF_GCAL, REF_READWISE]);
      expect(store.externalRefsOf(WS, NODE_B)).toEqual([]);
      store.close();
    });

    it("a mapping may name a not-yet-synced node (no referential integrity)", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_C }, 1727200001000));
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBe(NODE_C);
      expect(store.getNode(NODE_C)).toBeUndefined();
      store.close();
    });

    it("a re-set moves the mapping: the old carrier loses the ref, both reads follow", () => {
      const store = Store.open(adapter.makeBackend());
      store.applyMany([createPage(NODE_A, 1727200001000), createPage(NODE_B, 1727200001100)]);
      store.apply(env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_A }, 1727200002000));
      store.apply(env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_B }, 1727200003000));
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBe(NODE_B);
      expect(store.externalRefsOf(WS, NODE_A)).toEqual([]);
      expect(store.externalRefsOf(WS, NODE_B)).toEqual([REF_GCAL]);
      store.close();
    });

    it("racing sets converge on the higher (hlc, actor) tuple under either delivery order", () => {
      const setA = env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_A }, 1727200002000);
      const setB = env(
        "external_ref.set",
        { ref: REF_GCAL, nodeId: NODE_B },
        1727200002000,
        1,
        ACTOR_PHONE,
      );
      const forward = Store.open(adapter.makeBackend());
      forward.applyMany([setA, setB]);
      const backward = Store.open(adapter.makeBackend());
      backward.applyMany([setB, setA]);
      expect(forward.resolveExternalRef(WS, REF_GCAL)).toBe(NODE_B);
      expect(backward.resolveExternalRef(WS, REF_GCAL)).toBe(NODE_B);
      forward.close();
      backward.close();
    });

    it("a stale re-set (equal hlc, same actor) is dropped", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_A }, 1727200002000));
      store.apply(env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_B }, 1727200002000));
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBe(NODE_A);
      store.close();
    });

    it("delete tombstones the ref; the tombstone kills a stale set delivered later (both orders converge)", () => {
      const setNew = env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_B }, 1727200003000);
      const deleteWins = env("external_ref.delete", { ref: REF_GCAL }, 1727200004000);
      const setStale = env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_A }, 1727200002000);
      const setRevival = env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_C }, 1727200005000);

      // In-order: set, delete.
      const ordered = Store.open(adapter.makeBackend());
      ordered.applyMany([setStale, setNew, deleteWins]);
      expect(ordered.resolveExternalRef(WS, REF_GCAL)).toBeNull();
      expect(ordered.externalRefsOf(WS, NODE_B)).toEqual([]);

      // Out-of-order: the winner lands first, the stale set LAST — the
      // tombstone must drop it (this is the divergence the tombstone exists
      // to prevent).
      const reordered = Store.open(adapter.makeBackend());
      reordered.applyMany([setNew, deleteWins, setStale]);
      expect(reordered.resolveExternalRef(WS, REF_GCAL)).toBeNull();
      expect(reordered.externalRefsOf(WS, NODE_B)).toEqual([]);
      expect(reordered.externalRefsOf(WS, NODE_A)).toEqual([]);

      // And the reverse race: a NEWER set revives over the tombstone.
      const revival = Store.open(adapter.makeBackend());
      revival.applyMany([deleteWins, setRevival]);
      expect(revival.resolveExternalRef(WS, REF_GCAL)).toBe(NODE_C);
      ordered.close();
      reordered.close();
      revival.close();
    });

    it("a delete of an UNMAPPED ref still lands its tombstone — a stale concurrent set loses", () => {
      const store = Store.open(adapter.makeBackend());
      const deleteFirst = env("external_ref.delete", { ref: REF_READWISE }, 1727200003000);
      const staleSet = env("external_ref.set", { ref: REF_READWISE, nodeId: NODE_A }, 1727200002000);
      store.apply(deleteFirst);
      store.apply(staleSet);
      expect(store.resolveExternalRef(WS, REF_READWISE)).toBeNull();
      // A NEWER set revives over the tombstone (normal LWW).
      store.apply(env("external_ref.set", { ref: REF_READWISE, nodeId: NODE_B }, 1727200004000));
      expect(store.resolveExternalRef(WS, REF_READWISE)).toBe(NODE_B);
      store.close();
    });

    it("a stale delete (older than the standing set) leaves the mapping intact", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_A }, 1727200003000));
      store.apply(env("external_ref.delete", { ref: REF_GCAL }, 1727200002000));
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBe(NODE_A);
      expect(store.externalRefsOf(WS, NODE_A)).toEqual([REF_GCAL]);
      store.close();
    });

    it("hard-delete purges the node's rows; soft-trash keeps them", () => {
      const store = Store.open(adapter.makeBackend());
      store.applyMany([createPage(NODE_A, 1727200001000), createPage(NODE_B, 1727200001100)]);
      store.apply(env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_A }, 1727200002000));
      store.apply(env("external_ref.set", { ref: REF_READWISE, nodeId: NODE_A }, 1727200002100));
      store.apply(env("external_ref.set", { ref: REF_READITLATER, nodeId: NODE_B }, 1727200002200));

      // Soft-trash: the mappings ride (a restore re-activates the node with
      // its mappings intact).
      store.apply(env("object.delete", { objectId: NODE_A }, 1727200003000));
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBe(NODE_A);
      expect(store.externalRefsOf(WS, NODE_A)).toEqual([REF_GCAL, REF_READWISE]);
      store.apply(env("object.restore", { objectId: NODE_A }, 1727200003100));
      expect(store.externalRefsOf(WS, NODE_A)).toEqual([REF_GCAL, REF_READWISE]);

      // Hard-delete: the subtree's rows are purged; B's mapping is untouched.
      store.apply(env("object.delete", { objectId: NODE_A, permanent: true }, 1727200004000));
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBeNull();
      expect(store.resolveExternalRef(WS, REF_READWISE)).toBeNull();
      expect(store.externalRefsOf(WS, NODE_A)).toEqual([]);
      expect(store.resolveExternalRef(WS, REF_READITLATER)).toBe(NODE_B);
      store.close();
    });

    it("trash.empty purges the rows of every emptied subtree", () => {
      const store = Store.open(adapter.makeBackend());
      store.applyMany([createPage(NODE_A, 1727200001000), createPage(NODE_B, 1727200001100)]);
      store.apply(env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_A }, 1727200002000));
      store.apply(env("external_ref.set", { ref: REF_READWISE, nodeId: NODE_B }, 1727200002100));
      store.apply(env("object.delete", { objectId: NODE_A }, 1727200003000));
      store.apply(env("object.delete", { objectId: NODE_B }, 1727200003100));
      store.apply(env("trash.empty", {}, 1727200004000));
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBeNull();
      expect(store.resolveExternalRef(WS, REF_READWISE)).toBeNull();
      expect(store.externalRefsOf(WS, NODE_A)).toEqual([]);
      store.close();
    });

    it("malformed payloads fail loud at the apply boundary", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(createPage(NODE_A, 1727200001000));
      expect(() =>
        store.apply(env("external_ref.set", { ref: "", nodeId: NODE_A }, 1727200002000)),
      ).toThrow(EnvelopeValidationError);
      expect(() =>
        store.apply(
          env("external_ref.set", { ref: "x".repeat(513), nodeId: NODE_A }, 1727200002100),
        ),
      ).toThrow(EnvelopeValidationError);
      expect(() =>
        store.apply(env("external_ref.set", { ref: REF_GCAL }, 1727200002200)),
      ).toThrow(EnvelopeValidationError);
      expect(() =>
        store.apply(
          env("external_ref.set", { ref: REF_GCAL, nodeId: "not-a-uuid" }, 1727200002300),
        ),
      ).toThrow(EnvelopeValidationError);
      expect(() =>
        store.apply(
          env("external_ref.set", { ref: REF_GCAL, nodeId: NODE_A, kind: "event" }, 1727200002400),
        ),
      ).toThrow(EnvelopeValidationError);
      expect(() => store.apply(env("external_ref.delete", { ref: "" }, 1727200002500))).toThrow(
        EnvelopeValidationError,
      );
      expect(() =>
        store.apply(env("external_ref.delete", { ref: REF_GCAL, nodeId: NODE_A }, 1727200002600)),
      ).toThrow(EnvelopeValidationError);
      expect(store.resolveExternalRef(WS, REF_GCAL)).toBeNull();
      store.close();
    });

    it("the canonical fixture converges under forward and reverse delivery of the mapping ops", () => {
      const A = "0192a000-0000-7000-8000-000000000b10";
      const B = "0192a000-0000-7000-8000-000000000b11";
      // The node creates and the permanent delete are causally ordered (a
      // hard delete cannot apply before its node's create) — the convergence
      // claim under reordering covers the MAPPING ops, whose only
      // interdependencies are the LWW tuples.
      const creates = [createPage(A, 1727200050000), createPage(B, 1727200050100)];
      const mappingOps = [
        env("external_ref.set", { ref: REF_GCAL, nodeId: A }, 1727200050200),
        env("external_ref.set", { ref: REF_READWISE, nodeId: A }, 1727200050300),
        env("external_ref.set", { ref: REF_GCAL, nodeId: B }, 1727200050400),
        env("external_ref.delete", { ref: REF_READWISE }, 1727200050500),
        // A delete race: the delete wins, then a stale set is dropped.
        env("external_ref.set", { ref: REF_READITLATER, nodeId: A }, 1727200050600),
        env("external_ref.set", { ref: REF_READITLATER, nodeId: B }, 1727200050700),
        env("external_ref.delete", { ref: REF_READITLATER }, 1727200050800),
      ];
      const purge = env("object.delete", { objectId: A, permanent: true }, 1727200050900);
      const fixture = [...creates, ...mappingOps, purge];

      const forward = Store.open(adapter.makeBackend());
      forward.applyMany(fixture);
      const backward = Store.open(adapter.makeBackend());
      backward.applyMany([...creates, ...[...mappingOps].reverse(), purge]);

      for (const store of [forward, backward]) {
        expect(store.resolveExternalRef(WS, REF_GCAL)).toBe(B);
        // The delete won the readitlater race; the middle set lost to it.
        expect(store.resolveExternalRef(WS, REF_READITLATER)).toBeNull();
        expect(store.resolveExternalRef(WS, REF_READWISE)).toBeNull();
        expect(store.externalRefsOf(WS, A)).toEqual([]);
        expect(store.externalRefsOf(WS, B)).toEqual([REF_GCAL]);
        // Idempotent replay.
        store.applyMany(fixture);
        expect(store.externalRefsOf(WS, B)).toEqual([REF_GCAL]);
      }
      forward.close();
      backward.close();
    });
  });
}
