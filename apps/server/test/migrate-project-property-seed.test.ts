/**
 * The `project` property seed migration (scripts/migrate-project-property-seed.mts).
 *
 * End-to-end harness in the migrate-seed-pins shape: a scratch relay carries
 * THREE fixture workspaces, one per drift shape a live workspace can carry:
 *
 *  - WS_MISSING — the pre-slice live workspace: the task class node (+ the
 *    six family schemas + a family binding) with NO project schema and NO
 *    binding — the script plans `propertySchema.create` + `class.property.set`;
 *  - WS_PARTIAL — a workspace that already carries the project schema (global,
 *    the seed shape) but NOT the task binding — the binding alone is planned;
 *  - WS_DRIFT — a workspace whose project schema exists at a LOCAL scope
 *    (drifted from the global seed) with no binding — the scope clears FIRST
 *    (`propertySchema.update {scopeClassIds: null}`), the binding lands in
 *    the same ingest, ordered after it (the migrate-url-source-binding
 *    precedent — the R5 dead-config guard would reject the binding on a
 *    scope that does not reach task).
 *
 * Then: the dry run prints the plan and writes nothing; --apply appends the
 * envelopes, a fresh hydration replays clean with every workspace converged,
 * and a second --apply plans nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envelopeSchema, newEnvelope, payloadSchemaFor, type Envelope } from "@notees/protocol";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
  TASK_FAMILY_SEED,
} from "@notees/domain";
import { Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../src/relay-storage.js";

import {
  buildEnvelopes,
  planSeed,
} from "../../../scripts/migrate-project-property-seed.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const MIGRATION_SCRIPT = "../../scripts/migrate-project-property-seed.mts";

const ACTOR = "51000000-0000-4000-8000-0000000000a1";
const DEVICE = "project-seed-test-device";

const TASK_ID = SYSTEM_CLASS_UUIDS.task;
const PROJECT_CLASS_ID = SYSTEM_CLASS_UUIDS.project;
const PROJECT_SCHEMA_ID = SYSTEM_PROPERTY_UUIDS.project;

const WS_MISSING = "4b7d1a00-2222-4000-8000-000000000011";
const WS_PARTIAL = "4b7d1a00-2222-4000-8000-000000000012";
const WS_DRIFT = "4b7d1a00-2222-4000-8000-000000000013";

const text = (s: string) => [{ type: "text", text: s }];

function push(
  envelopes: Envelope[],
  workspaceId: string,
  opType: string,
  payload: Record<string, unknown>,
  t: number,
): void {
  envelopes.push(
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      hlc: { physical: t, logical: 0 },
      opType,
      payload,
    }),
  );
}

/**
 * The three fixture workspaces, as authored BEFORE the seed slice. Every
 * envelope the appliers accept today — the script plans appends against the
 * converged state, not against hypotheticals.
 */
function fixtureEnvelopes(): Envelope[] {
  const envelopes: Envelope[] = [];
  let t = 1727200000000;
  const step = () => (t += 1000);

  // WS_MISSING: the pre-slice live workspace — task + project class nodes,
  // the six family schemas + one family binding, NO project schema/binding.
  push(envelopes, WS_MISSING, "class.create", {
    classId: TASK_ID,
    contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.task),
  }, step());
  push(envelopes, WS_MISSING, "class.create", {
    classId: PROJECT_CLASS_ID,
    contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.project),
  }, step());
  for (const entry of TASK_FAMILY_SEED) {
    push(envelopes, WS_MISSING, "propertySchema.create", {
      propertySchemaId: SYSTEM_PROPERTY_UUIDS[entry.property],
      name: entry.name,
      type: entry.type,
      options: [...(entry.options ?? [])],
    }, step());
    push(envelopes, WS_MISSING, "class.property.set", {
      classId: TASK_ID,
      propertySchemaId: SYSTEM_PROPERTY_UUIDS[entry.property],
    }, step());
  }

  // WS_PARTIAL: the project schema already exists at the seed shape (global,
  // multi, filter, hideWhenEmpty) — only the binding row is missing.
  push(envelopes, WS_PARTIAL, "class.create", {
    classId: TASK_ID,
    contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.task),
  }, step());
  push(envelopes, WS_PARTIAL, "propertySchema.create", {
    propertySchemaId: PROJECT_SCHEMA_ID,
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.project,
    type: "object",
    multi: true,
    targetClassFilter: [PROJECT_CLASS_ID],
    hideWhenEmpty: true,
  }, step());

  // WS_DRIFT: the project schema exists at a LOCAL scope (client-authored,
  // drifted from the global seed) with no binding — the scope must clear
  // FIRST, else the R5 dead-config guard rejects the task binding.
  push(envelopes, WS_DRIFT, "class.create", {
    classId: TASK_ID,
    contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.task),
  }, step());
  push(envelopes, WS_DRIFT, "propertySchema.create", {
    propertySchemaId: PROJECT_SCHEMA_ID,
    name: "Project",
    type: "object",
    multi: true,
    scopeClassIds: [PROJECT_CLASS_ID],
    targetClassFilter: [PROJECT_CLASS_ID],
  }, step());
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
function hydrate(relay: RelayStorage, workspaceId: string, store: Store): void {
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
}

const converged = (store: Store): boolean =>
  store.database
    .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
    .get(TASK_ID, PROJECT_SCHEMA_ID) !== undefined;

describe("migrate-project-property-seed.mts", () => {
  let dataDir: string;
  let relay: RelayStorage;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-project-seed-migrate-test-"));
    relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    relay.ingest(fixtureEnvelopes());
  });

  afterEach(() => {
    relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("plans the schema + binding for a missing workspace, the binding alone when the schema exists, scope-clear-first on drift — and applying the plan empties it", () => {
    // WS_MISSING: create + bind (2 envelopes, same ingest, create first).
    const storeMissing = Store.open(betterSqlite3Backend(":memory:"));
    hydrate(relay, WS_MISSING, storeMissing);
    const planMissing = planSeed(storeMissing);
    expect(planMissing).toMatchObject({
      taskClassMissing: false,
      schemaMissing: true,
      taskBound: false,
      currentScope: null,
      attributeDrift: [],
    });
    const envMissing = buildEnvelopes(WS_MISSING, planMissing);
    expect(envMissing.map((e) => e.opType)).toEqual([
      "propertySchema.create",
      "class.property.set",
    ]);
    expect(envMissing[0]!.payload).toMatchObject({
      propertySchemaId: PROJECT_SCHEMA_ID,
      name: "Project",
      type: "object",
      multi: true,
      targetClassFilter: [PROJECT_CLASS_ID],
      hideWhenEmpty: true,
    });
    // Global scope = the key is ABSENT.
    expect(envMissing[0]!.payload).not.toHaveProperty("scopeClassIds");
    expect(envMissing[1]!.payload).toEqual({
      classId: TASK_ID,
      propertySchemaId: PROJECT_SCHEMA_ID,
    });
    for (const envelope of envMissing) {
      expect(envelopeSchema.safeParse(envelope).success).toBe(true);
      expect(payloadSchemaFor(envelope.opType)!.safeParse(envelope.payload).success).toBe(true);
    }
    // Store-level idempotency: applying the plan empties it.
    for (const envelope of envMissing) storeMissing.apply(envelope);
    expect(planSeed(storeMissing).schemaMissing).toBe(false);
    expect(planSeed(storeMissing).taskBound).toBe(true);
    storeMissing.close();

    // WS_PARTIAL: the binding alone (1 envelope).
    const storePartial = Store.open(betterSqlite3Backend(":memory:"));
    hydrate(relay, WS_PARTIAL, storePartial);
    const planPartial = planSeed(storePartial);
    expect(planPartial).toMatchObject({
      schemaMissing: false,
      taskBound: false,
      currentScope: null,
    });
    const envPartial = buildEnvelopes(WS_PARTIAL, planPartial);
    expect(envPartial.map((e) => e.opType)).toEqual(["class.property.set"]);
    storePartial.close();

    // WS_DRIFT: the scope clear FIRST, the binding ordered after it.
    const storeDrift = Store.open(betterSqlite3Backend(":memory:"));
    hydrate(relay, WS_DRIFT, storeDrift);
    const planDrift = planSeed(storeDrift);
    expect(planDrift).toMatchObject({
      schemaMissing: false,
      taskBound: false,
      currentScope: [PROJECT_CLASS_ID],
    });
    const envDrift = buildEnvelopes(WS_DRIFT, planDrift);
    expect(envDrift.map((e) => e.opType)).toEqual([
      "propertySchema.update",
      "class.property.set",
    ]);
    expect(envDrift[0]!.payload).toEqual({
      propertySchemaId: PROJECT_SCHEMA_ID,
      scopeClassIds: null,
    });
    // The drifted attribute set (hideWhenEmpty unset on the stored row) is
    // REPORTED, never touched.
    expect(planDrift.attributeDrift.length).toBeGreaterThan(0);
    storeDrift.close();
  });

  it("dry run prints the plan and writes nothing", () => {
    const seqsBefore = new Map(
      [WS_MISSING, WS_PARTIAL, WS_DRIFT].map((workspace) => [
        workspace,
        relay.latestSeq(workspace),
      ]),
    );
    const result = runScript(["--data-dir", dataDir, "--all"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("planned project property seed");
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).toContain("propertySchema.create");
    expect(result.stdout).toContain("class.property.set");
    // Nothing was appended anywhere — every log is byte-identical in length.
    for (const workspace of [WS_MISSING, WS_PARTIAL, WS_DRIFT]) {
      expect(relay.latestSeq(workspace), workspace).toBe(seqsBefore.get(workspace));
    }
  });

  it("--apply appends the envelopes, every workspace converges on fresh hydration, and a second run plans nothing", () => {
    const apply = runScript(["--data-dir", dataDir, "--all", "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("ingested 2 envelope(s)"); // WS_MISSING
    expect(apply.stdout).toContain("ingested 1 envelope(s)"); // WS_PARTIAL
    expect(apply.stdout).toContain("ingested 2 envelope(s)"); // WS_DRIFT

    for (const workspace of [WS_MISSING, WS_PARTIAL, WS_DRIFT]) {
      const fresh = Store.open(betterSqlite3Backend(":memory:"));
      try {
        hydrate(relay, workspace, fresh);
        expect(converged(fresh), workspace).toBe(true);
        const scope = fresh.database
          .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
          .get(PROJECT_SCHEMA_ID) as { scope_class_ids: string | null };
        expect(scope.scope_class_ids, workspace).toBeNull();
      } finally {
        fresh.close();
      }
    }

    // Idempotent: the second run plans nothing.
    const second = runScript(["--data-dir", dataDir, "--all", "--apply"]);
    expect(second.status).toBe(0);
    for (const workspace of [WS_MISSING, WS_PARTIAL, WS_DRIFT]) {
      expect(second.stdout).toContain(workspace);
    }
    expect(second.stdout.match(/already converged/g)?.length).toBe(3);
  });
});
