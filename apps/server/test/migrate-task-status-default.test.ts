/**
 * Task-Status default convergence migration (scripts/migrate-task-status-default.mts).
 *
 * End-to-end harness in the migrate-meeting-date-retirement shape: the test
 * builds a scratch relay whose workspace predates the schema default — the
 * task class carries the Status schema (select, display "bullet") WITHOUT
 * default_value plus the (task, taskStatus) binding; one task node holds an
 * authored Pending row at idx 0, a second holds an authored Doing row, a
 * third is a NON-task carrier with an authored Pending row (no binding
 * brings the property into its context — the PLAN must KEEP it, re-reporting
 * deterministically on every run) — then:
 *
 *  1. spawns the script WITHOUT --apply — the dry run must print the plan
 *     (the schema update + the Pending unset + the KEEP line for the
 *     non-task carrier) and write nothing;
 *  2. exercises the exported plan/envelope functions in-process against the
 *     sync server's hydration shape: exactly the schema update + the one
 *     removal are planned (the Doing row is never a candidate), the
 *     envelopes are protocol-valid, and applying them makes the plan empty
 *     (idempotency at the store level) with the derived default covering
 *     the tombstoned row;
 *  3. exercises the applier gate in-process against a hydration whose
 *     (task, taskStatus) binding was removed after the plan was built: the
 *     planned unset is dropped there (the derived default cannot
 *     materialize) and reported, and the surviving batch alone leaves the
 *     authored row in place;
 *  4. spawns the script WITH --apply — the appended envelopes replay clean
 *     through a fresh hydration: the schema carries the JSON-encoded Pending
 *     default, the authored Pending row on the task node is tombstoned with
 *     the derived default showing instead, the Doing row and the non-task
 *     carrier's Pending row survive;
 *  5. re-runs --apply — idempotent: the second run plans nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope, payloadSchemaFor, envelopeSchema, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, TASK_STATUS_OPTION_UUIDS } from "@notees/domain";
import { getEffectiveProperties, Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../src/relay-storage.js";

import {
  buildTaskStatusDefaultEnvelopes,
  planIsEmpty,
  planTaskStatusDefault,
  simulateTaskStatusEnvelopesOnStore,
  TASK_STATUS_ID,
} from "../../../scripts/migrate-task-status-default.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const MIGRATION_SCRIPT = "../../scripts/migrate-task-status-default.mts";

const WORKSPACE = "4b7d1a00-4444-4000-8000-000000000001";
const ACTOR = "51000000-0000-4000-8000-0000000000aa";
const DEVICE = "task-status-default-test-device";

const TASK_ID = SYSTEM_CLASS_UUIDS.task;
const PENDING_ID = TASK_STATUS_OPTION_UUIDS.pending;
const DOING_ID = TASK_STATUS_OPTION_UUIDS.doing;

/** The node ids of the fixture workspace. */
const NODE_PENDING = "0192b000-0000-7000-8000-00000000e101";
const NODE_DOING = "0192b000-0000-7000-8000-00000000e102";
const NODE_UNBOUND = "0192b000-0000-7000-8000-00000000e103";

/**
 * The pre-default fixture: the task class with the Status schema (NO
 * defaultValue — the drifted shape) + the binding, three nodes covering the
 * redundant-Pending, other-value, and non-task-carrier arms.
 */
function fixtureEnvelopes(): Envelope[] {
  const envelopes: Envelope[] = [];
  let t = 1730400000000;
  const step = () => (t += 1000);
  const text = (s: string) => [{ type: "text", text: s }];
  const push = (opType: string, payload: Record<string, unknown>, affected: string[] = []) =>
    envelopes.push(
      newEnvelope({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        deviceId: DEVICE,
        hlc: { physical: step(), logical: 0 },
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );

  push("class.create", { classId: TASK_ID, contentAst: text("Task") }, [TASK_ID]);
  push(
    "propertySchema.create",
    {
      propertySchemaId: TASK_STATUS_ID,
      name: "Status",
      type: "select",
      options: [
        { id: PENDING_ID, label: "Pending", icon: "mdiCircle", color: "yellow" },
        { id: DOING_ID, label: "Doing", icon: "mdiCircleHalfFull", color: "orange" },
      ],
      display: "bullet",
    },
    [],
  );
  push("class.property.set", { classId: TASK_ID, propertySchemaId: TASK_STATUS_ID }, [TASK_ID]);

  const taskNode = (nodeId: string) =>
    push(
      "object.create",
      { objectId: nodeId, isEmbedded: false, classIds: [TASK_ID], contentAst: text("T") },
      [nodeId],
    );
  taskNode(NODE_PENDING);
  push(
    "property.set",
    { objectId: NODE_PENDING, propertySchemaId: TASK_STATUS_ID, value: PENDING_ID, idx: 0 },
    [NODE_PENDING],
  );

  taskNode(NODE_DOING);
  push(
    "property.set",
    { objectId: NODE_DOING, propertySchemaId: TASK_STATUS_ID, value: DOING_ID, idx: 0 },
    [NODE_DOING],
  );

  // A non-task carrier: the schema is global so the authored row is legal,
  // but no binding brings the property into this node's context — the
  // derived default never materializes here and the row must survive.
  push("object.create", { objectId: NODE_UNBOUND, isEmbedded: false, contentAst: text("N") }, [
    NODE_UNBOUND,
  ]);
  push(
    "property.set",
    { objectId: NODE_UNBOUND, propertySchemaId: TASK_STATUS_ID, value: PENDING_ID, idx: 0 },
    [NODE_UNBOUND],
  );
  return envelopes;
}

interface CliResult {
  stdout: string;
  status: number;
}

/** Spawn the migration script exactly as the runbook documents. */
function runScript(args: string[]): CliResult {
  try {
    const stdout = execFileSync(TSX, [MIGRATION_SCRIPT, ...args], {
      cwd: join(REPO_ROOT, "apps", "server"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
      status: failed.status ?? 1,
    };
  }
}

/** The sync server's hydration shape: snapshot (none here) + full tail. */
function hydrate(relay: RelayStorage, store: Store): void {
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(WORKSPACE, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
}

const valuesOf = (store: Store, nodeId: string): unknown[] =>
  (
    store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id",
      )
      .all(nodeId, TASK_STATUS_ID) as Array<{ value: string }>
  ).map((row) => JSON.parse(row.value));

describe("migrate-task-status-default.mts", () => {
  let dataDir: string;
  let relay: RelayStorage;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-task-status-default-test-"));
    relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    relay.ingest(fixtureEnvelopes());
    store = Store.open(betterSqlite3Backend(":memory:"));
    hydrate(relay, store);
  });

  afterEach(() => {
    store.close();
    relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("plans the schema update + the Pending removal only; the Doing row and the non-task carrier are not candidates", () => {
    const plan = planTaskStatusDefault(store);
    expect(plan.schemaMissing).toBe(false);
    expect(plan.schemaInactive).toBe(false);
    expect(plan.schemaUpdate).toBe(true);
    expect(plan.defaultDrift).toBeNull();
    expect(plan.removals).toEqual([
      { nodeId: NODE_PENDING, idx: 0, elementId: `${NODE_PENDING}:${TASK_STATUS_ID}:0` },
    ]);
    expect(plan.keeps).toHaveLength(1);
    expect(plan.keeps[0]!.nodeId).toBe(NODE_UNBOUND);
    expect(plan.keeps[0]!.reason).toContain("no winning active binding");
    expect(planIsEmpty(plan)).toBe(false);

    // The built envelopes are protocol-valid…
    const envelopes = buildTaskStatusDefaultEnvelopes(WORKSPACE, plan);
    expect(envelopes.map((envelope) => envelope.opType)).toEqual([
      "propertySchema.update",
      "property.unset",
    ]);
    for (const envelope of envelopes) {
      expect(envelopeSchema.safeParse(envelope).success).toBe(true);
      expect(payloadSchemaFor(envelope.opType)!.safeParse(envelope.payload).success).toBe(true);
    }

    // …and applying them makes the plan empty (idempotency at the store
    // level), with the derived default covering the tombstoned row. The
    // kept carrier re-reports deterministically.
    for (const envelope of envelopes) store.apply(envelope);
    const after = planTaskStatusDefault(store);
    expect(after.schemaUpdate).toBe(false);
    expect(after.removals).toHaveLength(0);
    expect(planIsEmpty(after)).toBe(true);
    expect(after.keeps.map((keep) => keep.nodeId)).toEqual([NODE_UNBOUND]);
    const derived = getEffectiveProperties(store.database, NODE_PENDING).find(
      (row) => row.propertySchemaId === TASK_STATUS_ID && row.idx === 0,
    );
    expect(derived?.source).toBe("default");
    expect(derived?.value).toBe(PENDING_ID);
  });

  it("the applier gate drops a planned unset when the derived default cannot materialize (binding gone at simulation time)", () => {
    const plan = planTaskStatusDefault(store);
    expect(plan.removals.map((removal) => removal.nodeId)).toEqual([NODE_PENDING]);
    const envelopes = buildTaskStatusDefaultEnvelopes(WORKSPACE, plan);
    expect(envelopes).toHaveLength(2);

    // A hydration whose (task, taskStatus) binding was removed after the
    // plan was built: the default cannot derive, so the tombstone would
    // lose the authored value — the gate must drop it and report.
    const broken = Store.open(betterSqlite3Backend(":memory:"));
    let simulation: ReturnType<typeof simulateTaskStatusEnvelopesOnStore>;
    try {
      hydrate(relay, broken);
      broken.apply(
        newEnvelope({
          workspaceId: WORKSPACE,
          actorId: ACTOR,
          deviceId: DEVICE,
          hlc: { physical: 1730400099000, logical: 0 },
          affectedNodeIds: [TASK_ID],
          opType: "class.property.unset",
          payload: { classId: TASK_ID, propertySchemaId: TASK_STATUS_ID },
        }),
      );
      const result = simulateTaskStatusEnvelopesOnStore(broken, envelopes);
      simulation = result;
      // The simulation store is throwaway — what matters is the surviving
      // list, which is exactly what ingest would persist.
      expect(simulation.envelopes.map((envelope) => envelope.opType)).toEqual([
        "propertySchema.update",
      ]);
      expect(simulation.rejected).toHaveLength(1);
      expect(simulation.rejected[0]!.nodeId).toBe(NODE_PENDING);
      expect(simulation.rejected[0]!.reason).toContain("does not materialize");
    } finally {
      broken.close();
    }

    // The surviving batch alone, replayed on a fresh hydration, leaves the
    // authored Pending row in place.
    const replay = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, replay);
      for (const envelope of simulation.envelopes) replay.apply(envelope);
      expect(valuesOf(replay, NODE_PENDING)).toEqual([PENDING_ID]);
    } finally {
      replay.close();
    }
  });

  it("dry run prints the plan (with the KEEP line) and writes nothing", () => {
    const seqBefore = relay.latestSeq(WORKSPACE);
    const result = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("planned taskStatus default convergence:");
    expect(result.stdout).toContain("update the Status schema: defaultValue = the Pending option id");
    expect(result.stdout).toContain(`unset  ${NODE_PENDING}`);
    expect(result.stdout).toContain(`KEEP   ${NODE_UNBOUND}`);
    expect(result.stdout).toContain("dry run");
    expect(relay.latestSeq(WORKSPACE)).toBe(seqBefore);
  });

  it("--apply lands the default, tombstones the authored Pending row, keeps Doing and the non-task carrier; a second run plans nothing", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("ingested 2 envelope(s)");

    // Fresh hydration (the shape every replica replays).
    const fresh = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, fresh);

      // The schema carries the JSON-encoded Pending default.
      const schema = fresh.database
        .prepare("SELECT default_value FROM property_schema WHERE id = ?")
        .get(TASK_STATUS_ID) as { default_value: string | null };
      expect(schema.default_value).toBe(JSON.stringify(PENDING_ID));

      // The authored Pending row is tombstoned; the derived default covers it.
      expect(valuesOf(fresh, NODE_PENDING)).toEqual([]);
      const derived = getEffectiveProperties(fresh.database, NODE_PENDING).find(
        (row) => row.propertySchemaId === TASK_STATUS_ID && row.idx === 0,
      );
      expect(derived?.source).toBe("default");
      expect(derived?.value).toBe(PENDING_ID);

      // The Doing row survives; the non-task carrier's Pending row survives.
      expect(valuesOf(fresh, NODE_DOING)).toEqual([DOING_ID]);
      expect(valuesOf(fresh, NODE_UNBOUND)).toEqual([PENDING_ID]);
    } finally {
      fresh.close();
    }

    // Idempotent: the second run plans nothing.
    const second = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to migrate");
  });
});
