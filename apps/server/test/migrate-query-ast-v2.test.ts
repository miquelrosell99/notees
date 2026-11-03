/**
 * Query-AST v2 migration (scripts/migrate-query-ast-v2.mts) — the Path-B
 * harness in the migrate-seed-pins shape: a scratch relay seeded with v1
 * query tokens across workspaces, the script spawned WITHOUT --apply (the
 * dry run reports the distribution and writes nothing), then WITH --apply
 * (every rewritten envelope re-validates against the strict v3 schemas, a
 * backup lands first, snapshots + derived DBs are dropped, restore_epoch
 * bumps per workspace, the schema_meta marker lands, and a second run plans
 * nothing). The server coordination rows (node_view.query_ast,
 * workflow_rule.criteria — same relay.db) rewrite in place, each trial-
 * compiled before the write; an intentionally unmapped token fails loud
 * naming the envelope.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import { newEnvelope, payloadSchemaFor, envelopeSchema, type Envelope } from "@notees/protocol";

import { RelayStorage } from "../src/relay-storage.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const MIGRATION_SCRIPT = "../../scripts/migrate-query-ast-v2.mts";

const WORKSPACE_A = "4b7d1a00-1111-4000-8000-0000000000a1";
const WORKSPACE_B = "4b7d1a00-2222-4000-8000-0000000000a2";
const ACTOR = "51000000-0000-4000-8000-000000000099";
const CLASS_ID = "0192a000-0000-7000-8000-000000000201";
const NODE_A = "0192a000-0000-7000-8000-000000000101";
const NODE_B = "0192a000-0000-7000-8000-000000000102";

function env(
  workspaceId: string,
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
): Envelope {
  return newEnvelope({
    workspaceId,
    actorId: ACTOR,
    deviceId: "query-ast-v2-test",
    hlc: { physical, logical: 0 },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

/** One v1 query token per envelope payload, across two workspaces. */
function fixtureEnvelopes(): Envelope[] {
  const text = (s: string) => [{ type: "text", text: s }];
  const v1Ast = {
    version: 1,
    scope: { type: "entire_workspace" },
    root: {
      type: "group",
      logic: "and",
      children: [
        { type: "class", classId: CLASS_ID },
        { type: "contentSet" },
        { type: "createdAfter", timestamp: "2026-01-01" },
      ],
    },
  };
  const v2Ast = {
    version: 2,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children: [{ type: "content", op: "exists" }] },
  };
  return [
    env(WORKSPACE_A, "object.create", {
      objectId: NODE_A,
      isEmbedded: false,
      contentAst: [
        ...text("A page"),
        { type: "query", queryAst: v1Ast },
        { type: "query", queryAst: v2Ast }, // already v2 — passes through
      ],
    }, 1_000),
    env(WORKSPACE_A, "object.update", {
      objectId: NODE_A,
      contentAst: [{ type: "query", queryAst: v1Ast }],
    }, 2_000),
    env(WORKSPACE_B, "object.create", {
      objectId: NODE_B,
      isEmbedded: false,
      contentAst: [{ type: "query", queryAst: v1Ast }],
    }, 1_500),
    // A non-AST op — the scan must skip it (and the log is still counted).
    env(WORKSPACE_B, "class.create", { classId: CLASS_ID, contentAst: text("Kind") }, 1_600),
  ];
}

/** Insert the server coordination rows (node_view + workflow_rule) into the relay DB. */
function seedServerRows(dataDir: string): void {
  // The RelayStorage constructor only runs the sync-log DDL; the coordination
  // DDL lives in the storage classes' constructors — replay it directly.
  const db = new Database(join(dataDir, "relay.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_view (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      name TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      query_ast TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_rule (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      trigger_op_type TEXT NOT NULL,
      criteria TEXT NOT NULL,
      actions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const v1Ast = JSON.stringify({
    version: 1,
    scope: { type: "entire_workspace" },
    root: {
      type: "group",
      logic: "and",
      children: [{ type: "isClass", isClass: true }, { type: "linkedTo", nodeId: NODE_A }],
    },
  });
  db.prepare(
    "INSERT INTO node_view (id, node_id, section_key, name, sequence, query_ast, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("view-1", NODE_A, "classed-nodes", "Tab 1", 0, v1Ast, 1, 1);
  db.prepare(
    "INSERT INTO workflow_rule (id, workspace_id, name, enabled, trigger_op_type, criteria, actions, created_at, updated_at) VALUES (?, ?, ?, 1, 'object.create', ?, '[]', 1, 1)",
  ).run("rule-1", WORKSPACE_A, "On create", v1Ast);
  db.close();
}

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TSX, [MIGRATION_SCRIPT, ...args], {
      cwd: join(REPO_ROOT, "apps", "server"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failed.status ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

/** Read every stored envelope payload back through the strict v3 schemas. */
function expectLogValid(dataDir: string): void {
  const Database = require("better-sqlite3");
  const db = new Database(join(dataDir, "relay.db"), { readonly: true });
  const rows = db.prepare("SELECT * FROM envelope ORDER BY seq ASC").all() as Array<{
    id: string;
    workspace_id: string;
    actor_id: string;
    device_id: string;
    client: string | null;
    physical: number;
    logical: number;
    affected_node_ids: string;
    op_type: string;
    payload: string;
    protocol_version: number;
    timestamp: string;
  }>;
  for (const row of rows) {
    const envelope = {
      id: row.id,
      protocolVersion: row.protocol_version,
      workspaceId: row.workspace_id,
      actorId: row.actor_id,
      deviceId: row.device_id,
      hlc: { physical: row.physical, logical: row.logical },
      affectedNodeIds: JSON.parse(row.affected_node_ids),
      opType: row.op_type,
      timestamp: row.timestamp,
      payload: JSON.parse(row.payload),
      ...(row.client !== null ? { client: row.client } : {}),
    };
    const checked = envelopeSchema.safeParse(envelope);
    expect(checked.success, `envelope ${row.id}: ${JSON.stringify(checked.error?.issues?.[0] ?? {})}`).toBe(true);
    const schema = payloadSchemaFor(row.op_type);
    expect(schema).toBeDefined();
    const checkedPayload = schema!.safeParse(envelope.payload);
    expect(checkedPayload.success, `payload of ${row.id}`).toBe(true);
  }
  db.close();
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "notees-query-ast-v2-migrate-"));
  const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
  relay.ingest(fixtureEnvelopes());
  relay.close();
  seedServerRows(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("migrate-query-ast-v2", () => {
  it("the dry run reports the v1 distribution and writes nothing", () => {
    const dry = runScript(["--data-dir", dataDir]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("DRY-RUN (read-only)");
    expect(dry.stdout).toContain(`workspace ${WORKSPACE_A}`);
    expect(dry.stdout).toContain(`workspace ${WORKSPACE_B}`);
    // Three v1 tokens across the log (two in A, one in B); one already v2.
    expect(dry.stdout).toContain("v1 → v2 rewritten=2");
    expect(dry.stdout).toContain("v1 → v2 rewritten=1");
    expect(dry.stdout).toContain("already v2 (passed through)=1");
    // The per-shape histogram names the v1 condition types.
    expect(dry.stdout).toContain("class: 3");
    expect(dry.stdout).toContain("contentSet: 3");
    expect(dry.stdout).toContain("createdAfter: 3");
    expect(dry.stdout).toContain("envelope payload rewrites planned: 3");
    expect(dry.stdout).toContain("server rows to rewrite: node_view=1; workflow_rule=1");
    expect(dry.stdout).toContain("restore_epoch bump: 2 workspace(s)");
    expect(dry.stdout).toContain("dry-run only — no writes");
    // Nothing moved: no backup, no marker, the log still parses.
    expect(readdirSync(dataDir).some((name) => name.includes(".bak-"))).toBe(false);
    const db = new Database(join(dataDir, "relay.db"), { readonly: true });
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get(),
    ).toBeUndefined();
    db.close();
    // And the v1 tokens are still v1 (the run was read-only).
    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    const page = relay.catchUp(WORKSPACE_A, 0, 100);
    const create = page.envelopes[0]!;
    const tokens = (create.payload as { contentAst: Array<{ type: string; queryAst?: { version: number } }> })
      .contentAst;
    expect(tokens.find((t) => t.type === "query")!.queryAst!.version).toBe(1);
    relay.close();
  });

  it("--apply rewrites the log + server rows, bumps restore_epoch, marks, and a second run plans nothing", () => {
    const apply = runScript(["--data-dir", dataDir, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("APPLY");
    expect(apply.stdout).toContain("backup written:");
    expect(apply.stdout).toContain("envelope payloads rewritten: 3");
    expect(apply.stdout).toContain("server rows rewritten: 2");
    expect(apply.stdout).toContain("restore_epoch bumped for 2 workspace(s)");
    expect(apply.stdout).toContain("marker written: query_ast_v2_migration_v1");

    // The backup exists and the rewritten log validates against the strict
    // v3 envelope + payload schemas.
    expect(readdirSync(dataDir).some((name) => name.startsWith("relay.db.bak-"))).toBe(true);
    expectLogValid(dataDir);

    // The v1 tokens are now v2 with the mapped shapes; the v2 token is byte-identical.
    const db = new Database(join(dataDir, "relay.db"), { readonly: true });
    const rows = db.prepare("SELECT workspace_id, payload FROM envelope WHERE op_type IN ('object.create','object.update') ORDER BY seq").all() as Array<{ workspace_id: string; payload: string }>;
    const mappedExpectation = {
      version: 2,
      scope: { type: "entire_workspace" },
      root: {
        type: "group",
        logic: "and",
        children: [
          { type: "member", family: "class", op: "in", target: { mode: "ids", ids: [CLASS_ID] } },
          { type: "content", op: "exists" },
          { type: "date", field: "created", op: "after", timestamp: "2026-01-01" },
        ],
      },
    };
    const aCreate = JSON.parse(rows[0]!.payload) as { contentAst: Array<{ type: string; queryAst: unknown }> };
    expect(aCreate.contentAst[1]).toEqual({ type: "query", queryAst: mappedExpectation });
    // The already-v2 token passed through untouched.
    expect(aCreate.contentAst[2]).toEqual({
      type: "query",
      queryAst: {
        version: 2,
        scope: { type: "entire_workspace" },
        root: { type: "group", logic: "and", children: [{ type: "content", op: "exists" }] },
      },
    });
    const aUpdate = JSON.parse(rows[1]!.payload) as { contentAst: Array<{ type: string; queryAst: unknown }> };
    expect(aUpdate.contentAst[0]).toEqual({ type: "query", queryAst: mappedExpectation });
    const bCreate = JSON.parse(rows[2]!.payload) as { contentAst: Array<{ type: string; queryAst: unknown }> };
    expect(bCreate.contentAst[0]).toEqual({ type: "query", queryAst: mappedExpectation });

    // Server rows: rewritten + trial-compiled (the mapped AST is what lands).
    const view = db.prepare("SELECT query_ast FROM node_view WHERE id = 'view-1'").get() as { query_ast: string };
    expect(JSON.parse(view.query_ast)).toEqual({
      version: 2,
      scope: { type: "entire_workspace" },
      root: {
        type: "group",
        logic: "and",
        children: [
          { type: "nodeField", field: "isClass", op: "eq", value: "true" },
          { type: "member", family: "links", op: "in", target: { mode: "ids", ids: [NODE_A] } },
        ],
      },
    });
    const rule = db.prepare("SELECT criteria FROM workflow_rule WHERE id = 'rule-1'").get() as { criteria: string };
    expect(JSON.parse(rule.criteria).version).toBe(2);

    // restore_epoch bumped per workspace; the marker row landed.
    const epochs = db.prepare("SELECT workspace_id, epoch FROM restore_epoch ORDER BY workspace_id").all() as Array<{ workspace_id: string; epoch: number }>;
    expect(epochs).toEqual([
      { workspace_id: WORKSPACE_A, epoch: 1 },
      { workspace_id: WORKSPACE_B, epoch: 1 },
    ]);
    const marker = db.prepare("SELECT value FROM schema_meta WHERE key = 'query_ast_v2_migration_v1'").get() as { value: string };
    expect(marker).toBeDefined();
    expect(JSON.parse(marker.value).envelopeRewrites).toBe(3);
    db.close();

    // Idempotent second run: the marker refuses without --force.
    const second = runScript(["--data-dir", dataDir, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already migrated");
    expect(second.stdout).not.toContain("envelope payloads rewritten:");
  });

  it("--workspace restricts the rewrite + the epoch bump to that workspace", () => {
    const apply = runScript(["--data-dir", dataDir, "--apply", "--workspace", WORKSPACE_B]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("envelope payloads rewritten: 1");
    const db = new Database(join(dataDir, "relay.db"), { readonly: true });
    const rows = db.prepare("SELECT workspace_id, payload FROM envelope WHERE op_type IN ('object.create','object.update') ORDER BY seq").all() as Array<{ workspace_id: string; payload: string }>;
    const versionOf = (payload: string): number => {
      const parsed = JSON.parse(payload) as { contentAst: Array<{ queryAst?: { version: number } }> };
      return parsed.contentAst.find((t) => t.queryAst !== undefined)!.queryAst!.version;
    };
    expect(versionOf(rows[0]!.payload)).toBe(1); // workspace A untouched
    expect(versionOf(rows[1]!.payload)).toBe(1); // workspace A untouched
    expect(versionOf(rows[2]!.payload)).toBe(2); // workspace B rewritten
    const epochs = db.prepare("SELECT workspace_id FROM restore_epoch ORDER BY workspace_id").all() as Array<{ workspace_id: string }>;
    expect(epochs).toEqual([{ workspace_id: WORKSPACE_B }]);
    db.close();
  });

  it("an unmapped garbage token fails loud naming the envelope", () => {
    // Seed a workspace whose query token is neither v1 nor v2.
    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    relay.ingest([
      env(WORKSPACE_A, "object.update", {
        objectId: NODE_A,
        contentAst: [
          { type: "query", queryAst: { version: 2, scope: { type: "pages" }, root: { type: "group", logic: "and", children: [{ type: "weather" }] } } },
        ],
      }, 3_000),
    ]);
    relay.close();

    // Dry-run reports the foreign shape and still exits 0.
    const dry = runScript(["--data-dir", dataDir]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("foreign=1");

    // --apply fails loud, names the envelope, writes nothing.
    const apply = runScript(["--data-dir", dataDir, "--apply"]);
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain("neither v1 nor v2");
    expect(apply.stderr).toContain("envelope");
    expect(readdirSync(dataDir).some((name) => name.includes(".bak-"))).toBe(false);
  });

  it("an unmappable v1 token fails loud at --apply (the mapping's own guard)", () => {
    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    relay.ingest([
      env(WORKSPACE_A, "object.update", {
        objectId: NODE_A,
        contentAst: [
          {
            type: "query",
            // v1 version with an unknown v1 condition type — the pure mapper
            // throws; the script must name the envelope, not skip silently.
            queryAst: {
              version: 1,
              scope: { type: "entire_workspace" },
              root: { type: "group", logic: "and", children: [{ type: "siblingsOf", nodeIds: [NODE_B] }] },
            },
          },
        ],
      }, 3_000),
    ]);
    relay.close();
    const dry = runScript(["--data-dir", dataDir]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("unmapped=1");
    const apply = runScript(["--data-dir", dataDir, "--apply"]);
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain("siblingsOf");
  });
});
