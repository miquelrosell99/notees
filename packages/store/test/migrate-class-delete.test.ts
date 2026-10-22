/**
 * migrate-class-delete.mts planner tests (owner ruling 2026-10-22, the
 * classes-gallery batch): the stored-log walker rewrites retired
 * `class.delete` envelopes and re-routes `object.delete` envelopes addressed
 * at class nodes to the new four-arm world. The suite pins every rewrite
 * arm on the plan AND replays the migrated log into a fresh Store to assert
 * the rebuilt end state — family toggled off, system class archived with
 * membership INTACT, user class trashed with membership intact, locked
 * deletes gone.
 */

import { describe, expect, it } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { Store } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import {
  planClassDeleteMigration,
  type StoredRow,
} from "../../../scripts/migrate-class-delete.mts";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const YEAR = "00000000-0000-0000-0001-000000000003";
const QUOTE = "00000000-0000-0000-0001-000000000006";
const TASK = "00000000-0000-0000-0001-000000000012";
const GENRE = "0192a000-0000-7000-8000-000000000b01";
const ORPHAN = "0192a000-0000-7000-8000-000000000b02";
const QUOTE_MEMBER = "0192a000-0000-7000-8000-000000000b10";
const GENRE_MEMBER = "0192a000-0000-7000-8000-000000000b11";
const PLAIN = "0192a000-0000-7000-8000-000000000b12";
const LATE_PAGE = "0192a000-0000-7000-8000-000000000b13";

let clock = 1_727_200_000_000;

function makeRow(opType: string, payload: Record<string, unknown>, affected: string[]): StoredRow {
  const physical = (clock += 100);
  const envelope = newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-migrate",
    hlc: { physical, logical: 0 },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
  return {
    seq: 0, // assigned by buildLog
    id: envelope.id,
    workspace_id: envelope.workspaceId,
    actor_id: envelope.actorId,
    device_id: envelope.deviceId,
    client: envelope.client ?? null,
    physical: envelope.hlc.physical,
    logical: envelope.hlc.logical,
    affected_node_ids: JSON.stringify(affected),
    op_type: envelope.opType,
    payload: JSON.stringify(payload),
    protocol_version: envelope.protocolVersion,
    timestamp: envelope.timestamp,
  };
}

function buildLog(): StoredRow[] {
  const rows = [
    makeRow("class.create", { classId: QUOTE, contentAst: [{ type: "text", text: "Quote" }] }, [QUOTE]),
    makeRow("class.create", { classId: YEAR, contentAst: [{ type: "text", text: "Year" }] }, [YEAR]),
    makeRow("class.create", { classId: TASK, contentAst: [{ type: "text", text: "Task" }] }, [TASK]),
    makeRow("class.create", { classId: GENRE, contentAst: [{ type: "text", text: "Genre" }] }, [GENRE]),
    makeRow(
      "object.create",
      { objectId: QUOTE_MEMBER, classIds: [QUOTE], contentAst: [{ type: "text", text: "q" }] },
      [QUOTE_MEMBER],
    ),
    makeRow(
      "object.create",
      { objectId: GENRE_MEMBER, classIds: [GENRE], contentAst: [{ type: "text", text: "g" }] },
      [GENRE_MEMBER],
    ),
    makeRow("object.create", { objectId: PLAIN, contentAst: [{ type: "text", text: "p" }] }, [PLAIN]),
    // class.delete arms:
    makeRow("class.delete", { classId: QUOTE }, [QUOTE]), // → object.update {active:false}
    makeRow("class.delete", { classId: TASK }, [TASK]), // → workspace.feature.set
    makeRow("class.delete", { classId: GENRE }, [GENRE]), // → object.delete
    makeRow("class.delete", { classId: YEAR }, [YEAR]), // locked → DROP
    makeRow("class.delete", { classId: ORPHAN }, [ORPHAN]), // never created → DROP
    // object.delete arms (targets known as classes at this position):
    makeRow("object.delete", { objectId: YEAR, permanent: false }, [YEAR]), // locked → DROP
    makeRow("object.delete", { objectId: TASK, permanent: false }, [TASK]), // family base → toggle
    makeRow("object.delete", { objectId: QUOTE, permanent: false }, [QUOTE]), // system → archival
    makeRow("object.delete", { objectId: GENRE, permanent: false }, [GENRE]), // user → UNCHANGED
    makeRow("object.delete", { objectId: PLAIN, permanent: false }, [PLAIN]), // node → UNCHANGED
    makeRow("object.create", { objectId: LATE_PAGE, contentAst: [{ type: "text", text: "late" }] }, [LATE_PAGE]),
  ];
  rows.forEach((row, index) => {
    row.seq = index + 1;
  });
  return rows;
}

/** Reconstruct the migrated wire envelopes (drops removed, rewrites applied). */
function migratedEnvelopes(rows: StoredRow[]): Envelope[] {
  const plan = planClassDeleteMigration(rows);
  const bySeq = new Map(plan.plans.map((p) => [p.seq, p]));
  const envelopes: Envelope[] = [];
  for (const row of rows) {
    const planned = bySeq.get(row.seq);
    if (planned?.action === "drop") continue;
    const opType = planned?.action === "rewrite" ? planned.opType : row.op_type;
    const payload = planned?.action === "rewrite" ? planned.payload : JSON.parse(row.payload);
    const affected =
      planned?.action === "rewrite" ? planned.affectedNodeIds : JSON.parse(row.affected_node_ids);
    envelopes.push({
      id: row.id,
      protocolVersion: row.protocol_version,
      workspaceId: row.workspace_id,
      actorId: row.actor_id,
      deviceId: row.device_id,
      hlc: { physical: row.physical, logical: row.logical },
      affectedNodeIds: affected,
      opType,
      timestamp: row.timestamp,
      payload,
    } as Envelope);
  }
  return envelopes;
}

describe("migrate-class-delete planner", () => {
  it("rewrites every arm: class.delete × 3 kinds, object.delete × locked/family/system; user and node deletes unchanged", () => {
    const rows = buildLog();
    const plan = planClassDeleteMigration(rows);
    const rewrites = new Map(
      plan.plans.filter((p) => p.action === "rewrite").map((p) => [p.seq, p]),
    );
    const drops = new Map(plan.plans.filter((p) => p.action === "drop").map((p) => [p.seq, p]));

    // seq 8: class.delete QUOTE (system, non-locked) → archival.
    expect(rewrites.get(8)).toMatchObject({
      action: "rewrite",
      opType: "object.update",
      payload: { objectId: QUOTE, active: false },
    });
    // seq 9: class.delete TASK (family base) → the toggle; envelope HLC/actor
    // ride the row untouched (the LWW row gate converges with racing toggles).
    const taskRewrite = rewrites.get(9);
    expect(taskRewrite).toMatchObject({
      action: "rewrite",
      opType: "workspace.feature.set",
      payload: { feature: "tasks", enabled: false },
      affectedNodeIds: [],
    });
    expect(rows[8]!.physical).toBeGreaterThan(0);
    // seq 10: class.delete GENRE (user) → plain trash delete.
    expect(rewrites.get(10)).toMatchObject({
      action: "rewrite",
      opType: "object.delete",
      payload: { objectId: GENRE, permanent: false },
    });
    // seqs 11-13: locked class.delete, orphan class.delete, locked
    // object.delete → all dropped.
    expect(drops.get(11)?.reason).toContain("locked system class");
    expect(drops.get(12)?.reason).toContain("never class.create'd");
    expect(drops.get(13)?.reason).toContain("locked system class");
    // seq 14: object.delete TASK → toggle; 15: object.delete QUOTE → archival.
    expect(rewrites.get(14)).toMatchObject({ opType: "workspace.feature.set" });
    expect(rewrites.get(15)).toMatchObject({ opType: "object.update" });
    // seqs 16-18: user-class delete, node delete, unrelated create — untouched.
    expect(rewrites.has(16) || drops.has(16)).toBe(false);
    expect(rewrites.has(17) || drops.has(17)).toBe(false);
    expect(rewrites.has(18) || drops.has(18)).toBe(false);
    expect(plan.scanNotes).toEqual([]);
    // The report counts add up.
    const ws = plan.workspaces.get(WS)!;
    expect(ws.classDeleteRows).toBe(5);
    expect(ws.classDeleteRewrites).toBe(3);
    expect(ws.classDeleteDrops).toBe(2);
    expect(ws.objectDeleteClassRows).toBe(4);
    expect(ws.objectDeleteRewrites).toBe(2);
    expect(ws.objectDeleteDrops).toBe(1);
  });

  it("replaying the migrated log rebuilds the membership-rides world", () => {
    const rows = buildLog();
    const envelopes = migratedEnvelopes(rows);
    // No retired op survives the migration.
    expect(envelopes.every((e) => e.opType !== "class.delete")).toBe(true);

    const store = Store.open(betterSqlite3Backend(":memory:"));
    store.applyMany(envelopes);

    // Arm 2 — the family base routed to the toggle (twice — idempotent LWW).
    expect(store.isFeatureEnabled(WS, "tasks")).toBe(false);
    expect(store.getNode(TASK)!.is_active).toBe(0);
    // Arm 3 — the system class archived (twice), NOT trashed…
    expect(store.getNode(QUOTE)!.is_active).toBe(0);
    expect(
      store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(QUOTE),
    ).toBeUndefined();
    // …and its membership INTACT (the old world had stripped it — the
    // migration deliberately converges onto membership rides).
    expect(store.getNode(QUOTE_MEMBER)!.class_ids).toBe(JSON.stringify([QUOTE]));
    // Arm 4 — the user class trashed with its membership intact.
    expect(store.getNode(GENRE)!.is_active).toBe(0);
    expect(
      store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(GENRE),
    ).toBeDefined();
    expect(store.getNode(GENRE_MEMBER)!.class_ids).toBe(JSON.stringify([GENRE]));
    // Arm 1 — the locked class outlived every delete thrown at it.
    expect(store.getNode(YEAR)!.is_active).toBe(1);
    // Unchanged rows replayed untouched: the node delete and the passthrough.
    expect(store.getNode(PLAIN)!.is_active).toBe(0);
    expect(
      store.database.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(PLAIN),
    ).toBeDefined();
    expect(store.getNode(LATE_PAGE)!.is_active).toBe(1);
    store.close();
  });

  it("idempotent plan: a second pass over an already-migrated log plans nothing", () => {
    const rows = buildLog();
    const once = migratedEnvelopes(rows).map((envelope, index) => ({
      seq: index + 1,
      id: envelope.id,
      workspace_id: envelope.workspaceId,
      actor_id: envelope.actorId,
      device_id: envelope.deviceId,
      client: envelope.client ?? null,
      physical: envelope.hlc.physical,
      logical: envelope.hlc.logical,
      affected_node_ids: JSON.stringify(envelope.affectedNodeIds),
      op_type: envelope.opType,
      payload: JSON.stringify(envelope.payload),
      protocol_version: envelope.protocolVersion,
      timestamp: envelope.timestamp,
    }));
    const second = planClassDeleteMigration(once);
    expect(second.plans).toEqual([]);
    expect(second.scanNotes).toEqual([]);
  });
});
