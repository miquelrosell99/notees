/**
 * scripts/migrate-main-parent-page.mts tests — the parent-page condition
 * (owner ruling 2026-10-15) migration core (snapshot-anchored; the relay
 * prunes covered envelopes on compaction, so violations born below the
 * snapshot horizon live in the snapshot BYTES, not in any rewriteable op).
 *
 * - Snapshot-baked rows (old-era state, inserted directly — their set-bit
 *   ops are pruned) are found by scanning the parent chains and cleared by
 *   direct derived-state surgery; the patched bytes are captured BEFORE the
 *   tail walk so the snapshot contains no tail-era state.
 * - The tail is walked through the NEW applier: violating set-bit envelopes
 *   apply MUTATED (bit cleared) so as-of state stays true to the rewritten
 *   log (children of a rewritten node are evaluated against the rewritten
 *   state); historical move/demote-class breaches are recorded as skips
 *   (replay-quarantined on hydrate, never rewritten).
 * - verifyMainParentPage is the real-hydrate acceptance bar: restore the
 *   patched snapshot, replay the rewritten tail through
 *   applyMany({quarantineMoveGuards}), quarantined == skips, zero violating
 *   rows.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";

import {
  clearPresentAsMain,
  countViolatingRows,
  verifyMainParentPage,
  violatingRowIds,
  walkMainParentPage,
} from "../../../scripts/migrate-main-parent-page.mts";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const PAGE = "0192a000-0000-7000-8000-000000000601";
const BLOCK = "0192a000-0000-7000-8000-000000000602";
const BAKED_X = "0192a000-0000-7000-8000-000000000610";
const BAKED_Y = "0192a000-0000-7000-8000-000000000611";
const Z = "0192a000-0000-7000-8000-000000000603";
const N = "0192a000-0000-7000-8000-000000000604";
const D = "0192a000-0000-7000-8000-000000000605";
const E = "0192a000-0000-7000-8000-000000000606";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const stores: Store[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

function makeStore(): Store {
  const store = Store.open(sqljsBackend(sqlModule));
  stores.push(store);
  return store;
}

const openStore = (): Store => {
  const store = makeStore();
  return store;
};

function env(opType: string, payload: Record<string, unknown>, physical: number): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-migrate-main-parent-page",
    hlc: { physical, logical: 0 },
    opType,
    payload,
  });
}

/** A baked violating row: old-era state with no surviving set-bit op. */
function insertBakedRow(store: Store, id: string, parentId: string): void {
  store.database
    .prepare(
      "INSERT INTO node (id, workspace_id, is_class, present_as_main, parent_id) VALUES (?, ?, 0, 1, ?)",
    )
    .run(id, WS, parentId);
}

const mainBitOf = (store: Store, id: string): number | undefined =>
  (store.getNode(id) as { present_as_main?: number } | undefined)?.present_as_main;

/**
 * The snapshot-era world: PAGE (parentless) > BLOCK, plus two BAKED violating
 * rows — X carries the bit under the BLOCK, Y carries it under X (the chain
 * fails at the same place; one scan pass flags both).
 */
function snapshotEra(store: Store): void {
  store.applyMany([
    env("object.create", { objectId: PAGE, presentAsMain: true }, 1000),
    env("object.create", { objectId: BLOCK, parentId: PAGE }, 1001),
  ]);
  insertBakedRow(store, BAKED_X, BLOCK);
  insertBakedRow(store, BAKED_Y, BAKED_X);
}

/**
 * The tail: Z created with the bit under BLOCK (violating — rewrite); N
 * created with the bit under PAGE then moved under BLOCK (historical
 * move-class breach — skip); D created with the bit under PAGE, E with the
 * bit under D, then D demoted while E remains (historical demote-class
 * breach — skip).
 */
function tail(): Envelope[] {
  return [
    env("object.create", { objectId: Z, parentId: BLOCK, presentAsMain: true }, 2000),
    env("object.create", { objectId: N, parentId: PAGE, presentAsMain: true }, 2001),
    env("object.create", { objectId: D, parentId: PAGE, presentAsMain: true }, 2002),
    env("object.create", { objectId: E, parentId: D, presentAsMain: true }, 2003),
    env("object.move", { objectId: N, parentId: BLOCK }, 2004),
    env("object.update", { objectId: D, presentAsMain: false }, 2005),
  ];
}

describe("migrate-main-parent-page snapshot-anchored core", () => {
  it("finds baked violations by the chain scan and clears them by surgery", () => {
    const store = makeStore();
    snapshotEra(store);
    expect(violatingRowIds(store).sort()).toEqual([BAKED_X, BAKED_Y].sort());
    expect(countViolatingRows(store)).toBe(2);

    clearPresentAsMain(store, violatingRowIds(store));
    expect(countViolatingRows(store)).toBe(0);
    expect(mainBitOf(store, BAKED_X)).toBe(0);
    expect(mainBitOf(store, BAKED_Y)).toBe(0);
  });

  it("walks the tail against the corrected snapshot state and plans rewrite + skips", () => {
    const store = makeStore();
    snapshotEra(store);
    clearPresentAsMain(store, violatingRowIds(store));
    const patchedBytes = store.snapshot();

    const plan = walkMainParentPage(tail(), store);
    expect(plan.unexpected).toEqual([]);
    // Rewrite: only Z's violating create (N's move and D's demote are skips).
    expect(plan.rewrites.map((r) => r.objectId)).toEqual([Z]);
    // Skips: N's historical move under a block; D's demotion with E remaining.
    expect(plan.skips.map((s) => s.opType).sort()).toEqual(["object.move", "object.update"]);
    expect(plan.skips).toHaveLength(2);

    // The mutated walk state: Z applied as a block; N never moved (its
    // historical move replay-quarantines); D stays a page with E under it.
    expect(mainBitOf(store, Z)).toBe(0);
    expect(store.getNode(N)?.parent_id).toBe(PAGE);
    expect(mainBitOf(store, D)).toBe(1);
    expect(mainBitOf(store, E)).toBe(1);

    // The patched snapshot bytes carry the corrected state (no tail-era rows).
    const restored = makeStore();
    restored.restore(patchedBytes);
    expect(countViolatingRows(restored)).toBe(0);
    expect(restored.getNode(Z)).toBeUndefined();
    expect(restored.getNode(N)).toBeUndefined();
  });

  it("verify is the real-hydrate bar: patched snapshot + rewritten tail, quarantined == skips, zero violations", () => {
    const store = makeStore();
    snapshotEra(store);
    clearPresentAsMain(store, violatingRowIds(store));
    const patchedBytes = store.snapshot();
    const tailEnvelopes = tail();
    const plan = walkMainParentPage(tailEnvelopes, store);

    const result = verifyMainParentPage(tailEnvelopes, plan, patchedBytes, openStore);
    expect(result.quarantined).toBe(plan.skips.length);
    expect(result.violatingRows).toBe(0);
  });

  it("verify without a snapshot (tail-only workspace) holds the same bar", () => {
    const store = makeStore();
    // No snapshot: the tail starts from zero, so the PAGE create rides IN
    // the tail.
    const tailEnvelopes = [
      env("object.create", { objectId: PAGE, presentAsMain: true }, 1000),
      env("object.create", { objectId: Z, parentId: PAGE, presentAsMain: true }, 2000),
    ];
    const plan = walkMainParentPage(tailEnvelopes, store);
    expect(plan.rewrites).toEqual([]);

    const result = verifyMainParentPage(tailEnvelopes, plan, null, openStore);
    expect(result.quarantined).toBe(0);
    expect(result.violatingRows).toBe(0);
  });
});
