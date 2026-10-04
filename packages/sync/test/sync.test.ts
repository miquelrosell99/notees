/**
 * Sync engine tests: two-device convergence over one in-process relay,
 * retry/backoff/quarantine, restoreEpoch wipe+park recovery, catch-up replay
 * idempotency, and conflict reporting. Verifies the engine against the real
 * @notees/store (derived-state convergence via ordered full-database dumps,
 * the same approach as the store package's own tests).
 */

import { describe, expect, it } from "vitest";

import { Clock, newEnvelope, type Envelope } from "@notees/protocol";
import { Store, validateEnvelope } from "@notees/store";

import {
  MemoryRelay,
  MemoryTransport,
  SyncEngine,
  detectConflicts,
  type SyncConflict,
} from "../src/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const DEVICE_A = "device-a";
const DEVICE_B = "device-b";
const PARENT = "0192a000-0000-7000-8000-000000000010";
const NODE = "0192a000-0000-7000-8000-000000000011";
const CLASS_X = "0192a000-0000-7000-8000-0000000000c1";
const CLASS_Y = "0192a000-0000-7000-8000-0000000000c2";
const PROP_SCHEMA = "0192a000-0000-7000-8000-0000000000a1";
const T0 = 1_727_200_000_000;

/** Deterministic envelope factory (explicit HLC physical time per device op). */
function makeEnvelope(
  deviceId: string,
  physical: number,
  opType: string,
  payload: Record<string, unknown>,
  logical = 0,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId,
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

/** Base workspace: two classes, one property schema, a parent page, one child block. */
function baseEnvelopes(deviceId: string): Envelope[] {
  return [
    makeEnvelope(deviceId, T0 + 10, "class.create", { classId: CLASS_X, contentAst: [{ type: "text", text: "Class X" }] }),
    makeEnvelope(deviceId, T0 + 20, "class.create", { classId: CLASS_Y, contentAst: [{ type: "text", text: "Class Y" }] }),
    makeEnvelope(deviceId, T0 + 30, "propertySchema.create", {
      propertySchemaId: PROP_SCHEMA,
      name: "Rating",
      type: "text",
    }),
    makeEnvelope(deviceId, T0 + 40, "object.create", {
      objectId: PARENT,
      contentAst: [{ type: "text", text: "Parent" }],
    }),
    makeEnvelope(deviceId, T0 + 50, "object.create", {
      objectId: NODE,
      parentId: PARENT,
      contentAst: [{ type: "text", text: "Node" }],
    }),
  ];
}

/**
 * Full-database dump, deterministic ordering, for convergence checks.
 * Excludes sync_state (environmental), app_meta (device-local engine
 * bookkeeping), applied_envelope (the local apply log — cross-device apply
 * order legitimately differs), and FTS5 internals.
 */
function titleOf(store: Store, id: string): string {
  const row = store.getNode(id);
  if (row === undefined) return "";
  const ast = JSON.parse(row.content) as Array<{ type?: string; text?: string }>;
  return ast.map((t) => t.text ?? "").join(" ");
}

function dumpDb(store: Store): Record<string, unknown[]> {
  const tables = (
    store.database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT IN (
           'search_index_data', 'search_index_idx', 'search_index_config',
           'search_index_docsize', 'search_index_content'
         )
         AND name != 'sync_state'
         AND name != 'app_meta'
         AND name != 'applied_envelope'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    const rows = store.database.prepare(`SELECT * FROM "${table}"`).all() as Record<
      string,
      unknown
    >[];
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    dump[table] = rows;
  }
  return dump;
}

function propertyValue(store: Store, nodeId: string, schemaId: string): unknown {
  const row = store.database
    .prepare(
      "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = 0",
    )
    .get(nodeId, schemaId) as { value: string } | undefined;
  return row === undefined ? undefined : JSON.parse(row.value);
}

interface Device {
  store: Store;
  transport: MemoryTransport;
  engine: SyncEngine;
}

function makeDevice(
  relay: MemoryRelay,
  deviceId: string,
  now: () => number,
  onConflict?: (conflicts: SyncConflict[]) => void,
  onError?: (error: Error) => void,
): Device {
  const store = new Store();
  const transport = new MemoryTransport(relay);
  const engine = new SyncEngine(store, transport, new Clock(deviceId), {
    workspaceId: WS,
    now,
    ...((onConflict !== undefined || onError !== undefined)
      ? { callbacks: { ...(onConflict !== undefined ? { onConflict } : {}), ...(onError !== undefined ? { onError } : {}) } }
      : {}),
  });
  return { store, transport, engine };
}

describe("two-device convergence", () => {
  it("converges divergent offline edits over one MemoryTransport", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const conflictsA: SyncConflict[] = [];
    const conflictsB: SyncConflict[] = [];
    const a = makeDevice(relay, DEVICE_A, () => nowMs, (c) => conflictsA.push(...c));
    const b = makeDevice(relay, DEVICE_B, () => nowMs, (c) => conflictsB.push(...c));

    // A seeds the base state; its pull uploads the first snapshot.
    for (const envelope of baseEnvelopes(DEVICE_A)) a.engine.enqueue(envelope);
    await a.engine.syncOnce();
    expect(relay.envelopeCount).toBe(5);
    expect(relay.getSnapshotMeta().hasSnapshot).toBe(true);

    // B seeds from the same snapshot point.
    await b.engine.pull();
    expect(b.engine.getCursorSeq()).toBe(5);
    expect(dumpDb(b.store)).toEqual(dumpDb(a.store));

    // Divergent offline edits on both devices.
    a.engine.enqueue(
      makeEnvelope(DEVICE_A, T0 + 1000, "object.update", { objectId: NODE, contentAst: [{ type: "text", text: "name-from-A" }] }),
    );
    a.engine.enqueue(
      makeEnvelope(DEVICE_A, T0 + 1010, "object.create", { objectId: NODE, classIds: [CLASS_X] }),
    );
    a.engine.enqueue(
      makeEnvelope(DEVICE_A, T0 + 1020, "property.set", {
        objectId: NODE,
        propertySchemaId: PROP_SCHEMA,
        value: "value-from-A",
      }),
    );
    b.engine.enqueue(
      makeEnvelope(DEVICE_B, T0 + 2000, "object.update", { objectId: NODE, contentAst: [{ type: "text", text: "name-from-B" }] }),
    );
    b.engine.enqueue(
      makeEnvelope(DEVICE_B, T0 + 2010, "object.create", { objectId: NODE, classIds: [CLASS_Y] }),
    );
    b.engine.enqueue(
      makeEnvelope(DEVICE_B, T0 + 2020, "property.set", {
        objectId: NODE,
        propertySchemaId: PROP_SCHEMA,
        value: "value-from-B",
      }),
    );

    await a.engine.syncOnce();
    await b.engine.syncOnce();
    await a.engine.syncOnce();

    // Identical derived state on both devices.
    expect(dumpDb(a.store)).toEqual(dumpDb(b.store));

    // Name LWW: B's HLC is higher, so B wins on both devices.
    expect(titleOf(a.store, NODE)).toBe("name-from-B");
    expect(titleOf(b.store, NODE)).toBe("name-from-B");

    // Class membership is an OR-Set: the union converges on both devices.
    const classIdsA = new Set(JSON.parse(a.store.getNode(NODE)!.class_ids) as string[]);
    const classIdsB = new Set(JSON.parse(b.store.getNode(NODE)!.class_ids) as string[]);
    expect(classIdsA).toEqual(new Set([CLASS_X, CLASS_Y]));
    expect(classIdsB).toEqual(new Set([CLASS_X, CLASS_Y]));

    // Property LWW: B's write wins on both devices.
    expect(propertyValue(a.store, NODE, PROP_SCHEMA)).toBe("value-from-B");
    expect(propertyValue(b.store, NODE, PROP_SCHEMA)).toBe("value-from-B");

    // Every op was pushed exactly once (idempotent retries, no duplicates).
    expect(relay.envelopeCount).toBe(11);
    expect(conflictsA).toEqual([]);
    expect(conflictsB).toEqual([]);
  });
});

describe("retry and quarantine", () => {
  it("backs off through the schedule, then quarantines and recovers", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    let sendAttempts = 0;
    let failSend = true;
    const transport = new MemoryTransport(relay, {
      hooks: {
        beforeSendBatch: async () => {
          sendAttempts += 1;
          if (failSend) throw new Error("network down");
        },
      },
    });
    const store = new Store();
    const engine = new SyncEngine(store, transport, new Clock(DEVICE_A), {
      workspaceId: WS,
      now: () => nowMs,
    });
    const create = (id: string, name: string, physical: number) =>
      makeEnvelope(DEVICE_A, physical, "object.create", { objectId: id, contentAst: [{ type: "text", text: name }] });

    // Flaky transport: two failures, then the third attempt succeeds.
    const RETRY_NODE = "0192a000-0000-7000-8000-0000000000d1";
    engine.enqueue(create(RETRY_NODE, "retry-me", T0 + 3000));

    await expect(engine.syncOnce()).rejects.toThrow("network down");
    expect(engine.getOutboxCounts()).toEqual({ pending: 0, failed: 1, quarantined: 0 });
    expect(engine.getStatus()).toBe("error");

    // Not due yet: a push sends nothing.
    const attemptsAfterFailure = sendAttempts;
    await engine.push();
    expect(sendAttempts).toBe(attemptsAfterFailure);

    nowMs += 5_000;
    await expect(engine.syncOnce()).rejects.toThrow("network down");
    expect(engine.getOutboxCounts()).toEqual({ pending: 0, failed: 1, quarantined: 0 });

    nowMs += 15_000;
    failSend = false;
    await engine.syncOnce();
    expect(engine.getOutboxCounts()).toEqual({ pending: 0, failed: 0, quarantined: 0 });
    expect(engine.getStatus()).toBe("idle");
    expect(titleOf(store, RETRY_NODE)).toBe("retry-me");

    // Permanently failing transport: backoff exhausts → quarantined.
    failSend = true;
    const QUAR_NODE = "0192a000-0000-7000-8000-0000000000d2";
    engine.enqueue(create(QUAR_NODE, "quarantine-me", T0 + 4000));
    const backoff = [5_000, 15_000, 60_000, 300_000, 1_800_000] as const;
    for (let attempt = 1; attempt <= backoff.length; attempt += 1) {
      await expect(engine.syncOnce()).rejects.toThrow("network down");
      expect(engine.getOutboxCounts()).toEqual({ pending: 0, failed: 1, quarantined: 0 });
      nowMs += backoff[attempt - 1]!;
    }
    await expect(engine.syncOnce()).rejects.toThrow("network down");
    expect(engine.getOutboxCounts()).toEqual({ pending: 0, failed: 0, quarantined: 1 });

    // requeueQuarantined recovers once the transport heals.
    failSend = false;
    await engine.requeueQuarantined();
    expect(engine.getOutboxCounts()).toEqual({ pending: 0, failed: 0, quarantined: 0 });
    expect(titleOf(store, QUAR_NODE)).toBe("quarantine-me");
  });
});

describe("restoreEpoch change", () => {
  it("parks unsent envelopes, wipes, pulls from 0, and requeues without loss", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const parkedLog: number[] = [];
    const aStore = new Store();
    const aEngine = new SyncEngine(aStore, new MemoryTransport(relay), new Clock(DEVICE_A), {
      workspaceId: WS,
      now: () => nowMs,
      callbacks: { onParkedChanges: (count) => parkedLog.push(count) },
    });

    for (const envelope of baseEnvelopes(DEVICE_A)) aEngine.enqueue(envelope);
    await aEngine.syncOnce();
    expect(aEngine.getRestoreEpoch()).toBe(0);

    // Unsent local edit, then the server announces a restore.
    aEngine.enqueue(
      makeEnvelope(DEVICE_A, T0 + 5000, "object.update", { objectId: NODE, contentAst: [{ type: "text", text: "edited-locally" }] }),
    );
    relay.bumpRestoreEpoch();

    // pull() (not a full sync) so the edit is still unsent when the epoch hits.
    await aEngine.pull();

    expect(aEngine.getRestoreEpoch()).toBe(1);
    expect(parkedLog).toEqual([1, 0]);
    expect(aEngine.getOutboxCounts()).toEqual({ pending: 0, failed: 0, quarantined: 0 });
    expect(aEngine.getCursorSeq()).toBe(6);
    expect(titleOf(aStore, NODE)).toBe("edited-locally");

    // A fresh device on the restored server converges to identical state.
    const b = makeDevice(relay, DEVICE_B, () => nowMs);
    await b.engine.pull();
    expect(b.engine.getRestoreEpoch()).toBe(1);
    expect(dumpDb(b.store)).toEqual(dumpDb(aStore));
  });
});

describe("catch-up replay idempotency", () => {
  it("applies overlapping pages and duplicate deliveries exactly once", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const a = makeDevice(relay, DEVICE_A, () => nowMs);
    const b = makeDevice(relay, DEVICE_B, () => nowMs);
    for (const envelope of baseEnvelopes(DEVICE_A)) a.engine.enqueue(envelope);
    await a.engine.syncOnce();

    await b.engine.pull();
    expect(b.engine.getCursorSeq()).toBe(5);
    const appliedRows = () =>
      (
        b.store.database.prepare("SELECT COUNT(*) AS n FROM applied_envelope").get() as {
          n: number;
        }
      ).n;
    expect(appliedRows()).toBe(5);
    const before = dumpDb(b.store);

    // Duplicate WS deliveries of an already-covered catch-up page.
    const page = await b.transport.catchUp(0);
    const envelopes = page.envelopes.map((input) => validateEnvelope(input));
    const seqs = Object.fromEntries(envelopes.map((envelope, index) => [envelope.id, index + 1]));
    b.engine.onRemoteBatch(envelopes, seqs);
    b.engine.onRemoteBatch(envelopes, seqs);
    expect(appliedRows()).toBe(5);
    expect(dumpDb(b.store)).toEqual(before);
    expect(b.engine.getCursorSeq()).toBe(5);

    // A pull on the same cursor fetches nothing new.
    const pulled: number[] = [];
    b.engine.setCallbacks({ onPull: (count) => pulled.push(count) });
    await b.engine.pull();
    expect(pulled).toEqual([0]);
    expect(appliedRows()).toBe(5);
  });
});

describe("conflict detection", () => {
  it("reports property_conflict and node_deleted to the callback while applying", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const conflicts: SyncConflict[] = [];
    const a = makeDevice(relay, DEVICE_A, () => nowMs, (c) => conflicts.push(...c));
    for (const envelope of baseEnvelopes(DEVICE_A)) a.engine.enqueue(envelope);
    await a.engine.syncOnce();

    // Local pending ops (unsent): an unset on a slot, and an edit to PARENT.
    const localUnset = makeEnvelope(DEVICE_A, T0 + 6000, "property.unset", {
      objectId: NODE,
      propertySchemaId: PROP_SCHEMA,
      idx: 0,
    });
    const localEdit = makeEnvelope(DEVICE_A, T0 + 6010, "object.update", {
      objectId: PARENT,
      contentAst: [{ type: "text", text: "local-edit" }],
    });
    a.engine.enqueue(localUnset);
    a.engine.enqueue(localEdit);

    // Remote batch over the realtime path: a property.set on the same slot A
    // just unset, plus a delete of the node A is editing.
    const remoteSet = makeEnvelope(DEVICE_B, T0 + 7000, "property.set", {
      objectId: NODE,
      propertySchemaId: PROP_SCHEMA,
      value: "remote-value",
      idx: 0,
    });
    const remoteDelete = makeEnvelope(DEVICE_B, T0 + 7010, "object.delete", { objectId: PARENT });
    const base = a.engine.getCursorSeq();
    a.engine.onRemoteBatch([remoteSet, remoteDelete], {
      [remoteSet.id]: base + 1,
      [remoteDelete.id]: base + 2,
    });

    expect(conflicts).toHaveLength(2);
    const byType = new Map(conflicts.map((conflict) => [conflict.conflictType, conflict]));
    expect(byType.get("property_conflict")).toMatchObject({
      nodeId: NODE,
      localEnvelopeIds: [localUnset.id],
      remoteEnvelopeIds: [remoteSet.id],
    });
    expect(byType.get("node_deleted")).toMatchObject({
      nodeId: PARENT,
      localEnvelopeIds: [localEdit.id],
      remoteEnvelopeIds: [remoteDelete.id],
    });

    // Apply proceeded regardless: the remote write won LWW over the unset
    // tombstone, and PARENT is soft-deleted.
    expect(propertyValue(a.store, NODE, PROP_SCHEMA)).toBe("remote-value");
    expect(a.store.getNode(PARENT)!.is_active).toBe(0);
  });

  it("detectConflicts flags move_move and class_conflict, and stays quiet on agreed edits", () => {
    const node = "0192a000-0000-7000-8000-0000000000aa";
    const p1 = "0192a000-0000-7000-8000-0000000000b1";
    const p2 = "0192a000-0000-7000-8000-0000000000b2";
    const remote = [
      makeEnvelope(DEVICE_B, T0 + 8000, "object.create", { objectId: node, parentId: p1 }),
      makeEnvelope(DEVICE_B, T0 + 8010, "object.create", { objectId: node, classIds: [CLASS_X] }),
      makeEnvelope(DEVICE_B, T0 + 8020, "property.set", {
        objectId: node,
        propertySchemaId: PROP_SCHEMA,
        value: "remote",
      }),
    ];
    const local = [
      makeEnvelope(DEVICE_A, T0 + 8100, "object.create", { objectId: node, parentId: p2 }),
      makeEnvelope(DEVICE_A, T0 + 8110, "object.create", { objectId: node, classIds: [CLASS_Y] }),
      makeEnvelope(DEVICE_A, T0 + 8120, "property.set", {
        objectId: node,
        propertySchemaId: PROP_SCHEMA,
        value: "local",
      }),
    ];
    const types = detectConflicts(remote, local).map((conflict) => conflict.conflictType);
    expect(types).toContain("move_move");
    expect(types).toContain("class_conflict");
    // set-vs-set on the same slot is LWW, not a conflict; agreed parents neither.
    expect(types).not.toContain("property_conflict");
    expect(types).not.toContain("node_deleted");
  });

  it("detectConflicts flags node_deleted in the local-delete direction", () => {
    const remote = [
      makeEnvelope(DEVICE_B, T0 + 8200, "object.update", { objectId: NODE, contentAst: [{ type: "text", text: "remote edit" }] }),
    ];
    const local = [makeEnvelope(DEVICE_A, T0 + 8210, "object.delete", { objectId: NODE })];
    const conflicts = detectConflicts(remote, local);
    expect(conflicts.map((conflict) => conflict.conflictType)).toEqual(["node_deleted"]);
    expect(conflicts[0]!.nodeId).toBe(NODE);
  });
});

describe("remote poison quarantine", () => {
  it("a fresh device converges past a historical class-parenting move, surfacing the error once", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    // Historical log: base workspace, then a pre-Revision-11 class-parenting
    // move, then a normal op — exactly the live workspace's seq-52497 shape.
    relay.ingest([
      ...baseEnvelopes(DEVICE_A),
      makeEnvelope(DEVICE_A, T0 + 60, "object.move", { objectId: CLASS_X, parentId: PARENT }),
      makeEnvelope(DEVICE_A, T0 + 70, "object.update", {
        objectId: NODE,
        contentAst: [{ type: "text", text: "post-poison" }],
      }),
    ]);

    const errors: Error[] = [];
    const b = makeDevice(relay, DEVICE_B, () => nowMs, undefined, (e) => errors.push(e));
    await b.engine.pull();

    // Converged PAST the poison: cursor at the log tail, post-poison op live.
    expect(b.engine.getCursorSeq()).toBe(7);
    expect(titleOf(b.store, NODE)).toBe("post-poison");
    expect(b.store.getNode(CLASS_X)?.parentId ?? null).toBeNull();

    // The poison is quarantined (not retried) and surfaced via onError.
    const quarantined = b.store.quarantinedEnvelopes();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.opType).toBe("object.move");
    expect(errors.some((e) => /quarantined remote object\.move/.test(e.message))).toBe(true);
  });
});
