/**
 * migrate-pending.mts orchestrator tests (owner ruling 2026-10-22, the
 * batch-migration slice): the pending classification is pure, and the
 * end-to-end arms run against a synthetic relay DB in a tmp dir — the
 * dry-run reports a pending entry and delegates the per-script dry-run to a
 * child, --apply refuses while the stack reports running (the injected
 * check), and a real child-process --apply of migrate-class-delete on the
 * synthetic log lands the marker so a second pass plans nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { newEnvelope } from "@notees/protocol";

import {
  MIGRATION_REGISTRY,
  planPendingMigrations,
  readPresentMarkers,
  runMigratePending,
  type ChildResult,
} from "../../../scripts/migrate-pending.mts";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const GENRE = "0192a000-0000-7000-8000-000000000b01";

const CLASS_DELETE_ENTRY = MIGRATION_REGISTRY.find(
  (entry) => entry.markerKey === "class_delete_migration_v1",
)!;
const COLOR_TOKENS_ENTRY = MIGRATION_REGISTRY.find(
  (entry) => entry.markerKey === "color_token_migration_v1",
)!;

let clock = 1_727_200_000_000;
const tmpDirs: string[] = [];

function makeEnvelopeRow(opType: string, payload: Record<string, unknown>, affected: string[]) {
  const physical = (clock += 100);
  const envelope = newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-migrate-pending",
    hlc: { physical, logical: 0 },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
  return {
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

/**
 * A synthetic relay DB: the envelope/snapshot/restore_epoch tables the
 * migrate-class-delete script reads, one workspace carrying a user class and
 * a retired `class.delete` of it (its marker ABSENT — the migration is
 * pending), no snapshots.
 */
function buildRelayDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "notees-migrate-pending-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "relay.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE envelope (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      client TEXT,
      physical INTEGER NOT NULL,
      logical INTEGER NOT NULL,
      affected_node_ids TEXT NOT NULL,
      op_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE snapshot (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
    CREATE TABLE restore_epoch (workspace_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
  `);
  const insert = db.prepare(`
    INSERT INTO envelope (id, workspace_id, actor_id, device_id, client, physical, logical,
      affected_node_ids, op_type, payload, protocol_version, timestamp)
    VALUES (@id, @workspace_id, @actor_id, @device_id, @client, @physical, @logical,
      @affected_node_ids, @op_type, @payload, @protocol_version, @timestamp)
  `);
  insert.run(
    makeEnvelopeRow("class.create", { classId: GENRE, contentAst: [{ type: "text", text: "Genre" }] }, [GENRE]),
  );
  insert.run(makeEnvelopeRow("class.delete", { classId: GENRE }, [GENRE]));
  db.close();
  return { dir, dbPath };
}

function openRelay(dbPath: string): InstanceType<typeof Database> {
  return new Database(dbPath, { readonly: true });
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("planPendingMigrations (pure)", () => {
  it("classifies pending vs applied by marker presence", () => {
    const plan = planPendingMigrations(MIGRATION_REGISTRY, new Set([CLASS_DELETE_ENTRY.markerKey]));
    const byScript = new Map(plan.map((item) => [item.entry.script, item.status]));
    expect(byScript.get("migrate-class-delete.mts")).toBe("applied");
    expect(byScript.get("migrate-is-embedded.mts")).toBe("pending");
    expect(byScript.get("migrate-node-type.mts")).toBe("pending");
    expect(plan).toHaveLength(MIGRATION_REGISTRY.length);
  });

  it("an empty registry plans nothing", () => {
    expect(planPendingMigrations([], new Set())).toEqual([]);
    expect(planPendingMigrations([], new Set([CLASS_DELETE_ENTRY.markerKey]))).toEqual([]);
  });

  it("an empty marker set marks everything pending", () => {
    const plan = planPendingMigrations([COLOR_TOKENS_ENTRY], new Set());
    expect(plan).toEqual([{ entry: COLOR_TOKENS_ENTRY, status: "pending" }]);
  });
});

describe("migrate-pending on a synthetic relay DB", () => {
  it("reports the pending entry and delegates the per-script dry-run to a child", async () => {
    const { dir, dbPath } = buildRelayDb();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const children: Array<{ script: string; args: string[] }> = [];
    const fakeRunner = async (script: string, args: string[]): Promise<ChildResult> => {
      children.push({ script, args });
      return { code: 0, output: "3 envelope rewrites planned (dry-run)" };
    };

    const code = await runMigratePending({
      dbPath,
      apply: false,
      assumeStopped: false,
      force: false,
      stackDir: dir,
      runChild: fakeRunner,
    });

    expect(code).toBe(0);
    // Only the pending rewrite got a child; applied entries did not.
    const pendingChildren = children.filter((c) => c.args.includes("--dry-run"));
    expect(pendingChildren.map((c) => c.script)).toContain("migrate-class-delete.mts");
    expect(children.every((c) => !c.args.includes("--apply"))).toBe(true);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "PENDING  migrate-class-delete.mts",
    );
  });

  it("--apply refuses while the stack reports running (injected check), before any child", async () => {
    const { dir, dbPath } = buildRelayDb();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = vi.fn(async (): Promise<ChildResult> => ({ code: 0, output: "" }));

    const code = await runMigratePending({
      dbPath,
      apply: true,
      assumeStopped: false,
      force: false,
      stackDir: dir,
      checkSyncRunning: async () => true,
      runChild: runner,
    });

    expect(code).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("ABORTED");
    // Read-only overall: the marker table still does not exist.
    const db = openRelay(dbPath);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get(),
    ).toBeUndefined();
    db.close();
  });

  it("readPresentMarkers treats a missing schema_meta table as nothing applied", async () => {
    const { dbPath } = buildRelayDb();
    expect(await readPresentMarkers(dbPath)).toEqual(new Set());
  });

  it("child-process --apply lands the marker; a second pass plans nothing", { timeout: 180_000 }, async () => {
    const { dir, dbPath } = buildRelayDb();

    // Real child, same tsx runner as production (the default runner).
    const applyCode = await runMigratePending({
      dbPath,
      apply: true,
      assumeStopped: true,
      force: false,
      stackDir: dir,
    });
    expect(applyCode).toBe(0);

    const db = openRelay(dbPath);
    const marker = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(CLASS_DELETE_ENTRY.markerKey) as { value: string } | undefined;
    expect(marker).toBeDefined();
    // The stored class.delete envelope was rewritten away (user class → trash).
    const retired = db
      .prepare("SELECT COUNT(*) AS n FROM envelope WHERE op_type = 'class.delete'")
      .get() as { n: number };
    expect(retired.n).toBe(0);
    db.close();

    // Second invocation: nothing pending, no child called.
    const runner = vi.fn(async (): Promise<ChildResult> => ({ code: 0, output: "" }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const dryCode = await runMigratePending({
      dbPath,
      apply: false,
      assumeStopped: false,
      force: false,
      stackDir: dir,
      runChild: runner,
    });
    expect(dryCode).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "nothing pending",
    );
  });
});
