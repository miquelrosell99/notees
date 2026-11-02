/**
 * The pmid property seed migration (scripts/migrate-pmid-property.mts) — the
 * resolver's PMID support slice (2026-11-02).
 *
 * End-to-end harness in the migrate-seed-pins shape: the test builds a
 * scratch relay whose workspace predates the pmid property (the source class
 * + the other base schemas, NO pmid schema), then:
 *
 *  1. spawns the script WITHOUT --apply — the dry run prints the plan and
 *     writes nothing;
 *  2. exercises the exported plan functions in-process against the sync
 *     server's hydration shape (scratch store = snapshot + tail): the plan
 *     is exactly one propertySchema.create + one pinned class.property.set;
 *  3. spawns the script WITH --apply — the appended envelopes replay clean
 *     through a fresh hydration and the pinned source↔pmid rows land;
 *  4. re-runs --apply — idempotent: the second run plans nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";
import { Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../src/relay-storage.js";

import { buildEnvelopes, planPmid } from "../../../scripts/migrate-pmid-property.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const MIGRATION_SCRIPT = "../../scripts/migrate-pmid-property.mts";

const WORKSPACE = "4b7d1a00-2222-4000-8000-000000000002";
const ACTOR = "51000000-0000-4000-8000-000000000099";
const DEVICE = "pmid-migration-test-device";

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const PMID_ID = SYSTEM_PROPERTY_UUIDS.pmid;

/** The pre-pmid fixture: the source class + the doi schema, no pmid anywhere. */
function fixtureEnvelopes(): Envelope[] {
  const envelopes: Envelope[] = [];
  let t = 1727200000000;
  const step = () => (t += 1000);
  const text = (s: string) => [{ type: "text", text: s }];
  const push = (opType: string, payload: Record<string, unknown>) =>
    envelopes.push(
      newEnvelope({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        deviceId: DEVICE,
        hlc: { physical: step(), logical: 0 },
        opType,
        payload,
      }),
    );

  push("class.create", {
    classId: SOURCE_ID,
    contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.source),
  });
  push("propertySchema.create", {
    propertySchemaId: SYSTEM_PROPERTY_UUIDS.doi,
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.doi,
    type: "text",
    scopeClassIds: [SOURCE_ID],
  });
  push("class.property.set", {
    classId: SOURCE_ID,
    propertySchemaId: SYSTEM_PROPERTY_UUIDS.doi,
  });
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

describe("migrate-pmid-property.mts", () => {
  let dataDir: string;
  let relay: RelayStorage;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-pmid-migration-test-"));
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

  it("dry run prints the plan and writes nothing", () => {
    const seqBefore = relay.latestSeq(WORKSPACE);
    const result = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("planned pmid property seed:");
    expect(result.stdout).toContain("propertySchema.create");
    expect(result.stdout).toContain("pinned: true");
    expect(result.stdout).toContain("dry run");
    expect(relay.latestSeq(WORKSPACE)).toBe(seqBefore);
  });

  it("plans exactly the schema create + the pinned binding against the converged store", () => {
    const plan = planPmid(store);
    expect(plan.sourceClassMissing).toBe(false);
    expect(plan.schemaMissing).toBe(true);
    expect(plan.sourceBound).toBe(false);
    expect(plan.scopeBlocksBinding).toBe(false);
    expect(plan.attributeDrift).toEqual([]);

    const envelopes = buildEnvelopes(WORKSPACE, plan);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]!.opType).toBe("propertySchema.create");
    expect(envelopes[0]!.payload).toEqual({
      propertySchemaId: PMID_ID,
      name: "PMID",
      type: "text",
      scopeClassIds: [SOURCE_ID],
    });
    expect(envelopes[1]!.opType).toBe("class.property.set");
    expect(envelopes[1]!.payload).toEqual({
      classId: SOURCE_ID,
      propertySchemaId: PMID_ID,
      pinned: true,
    });
  });

  it("--apply appends the rows, replays clean, and a second run plans nothing", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("ingested 2 envelope(s)");

    // Fresh hydration (the shape every replica replays): clean + the rows.
    const fresh = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, fresh);
      const schema = fresh.database
        .prepare("SELECT name, type, scope_class_ids FROM property_schema WHERE id = ?")
        .get(PMID_ID) as { name: string; type: string; scope_class_ids: string | null };
      expect(schema.name).toBe("PMID");
      expect(schema.type).toBe("text");
      expect(JSON.parse(schema.scope_class_ids!)).toEqual([SOURCE_ID]);
      const binding = fresh.database
        .prepare("SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(SOURCE_ID, PMID_ID) as { pinned: number };
      expect(binding.pinned).toBe(1);
    } finally {
      fresh.close();
    }

    // Idempotent: the second run plans nothing.
    const second = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already converged");
  });
});
