/**
 * Task 8 — the authors object→text migration (scripts/migrate-authors-to-text.mts).
 *
 * End-to-end harness: the migration and its scratch seed companion are
 * operator scripts (tsx, /tmp-only) — the test spawns them exactly as the
 * runbook documents and asserts on a replica it rebuilds in-process through
 * the sync server's hydration shape.
 *
 * Review focus #1 is the load-bearing test: a replica that snapshotted the
 * workspace BEFORE the migration and then catches up the migrated tail must
 * converge with ZERO StoreError throws — in particular no replay may ever
 * validate an object {nodeId} value against the text schema. The test saves
 * a PRE-MIGRATION snapshot, applies the migration, then restores that
 * snapshot into a fresh store and applies the tail by hand.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseQueryAst, newEnvelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { nodeRefOfValue, visiblePropertyValueRows, Store } from "@notees/store";
import { runQuery } from "@notees/query";

import { RelayStorage } from "../src/relay-storage.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const SEED_SCRIPT = "../../scripts/migrated-verify/seed-authors-scratch.mts";
const MIGRATION_SCRIPT = "../../scripts/migrate-authors-to-text.mts";

const AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.authors;
const LINKED_AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.linkedAuthors;
const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;

const WORKSPACE_MAIN = "4b7d1a00-1111-4000-8000-000000000001";
const WORKSPACE_CONVERGED = "4b7d1a00-1111-4000-8000-000000000002";
const WORKSPACE_EMPTY = "4b7d1a00-1111-4000-8000-000000000003";
const PRE_MIGRATION_SNAPSHOT_ID = "7a000000-0000-4000-8000-000000000001";

const AGENT_A = "51000000-0000-4000-8000-000000000001";
const AGENT_B = "51000000-0000-4000-8000-000000000002";
const AGENT_C = "51000000-0000-4000-8000-000000000003";
const AGENT_D = "51000000-0000-4000-8000-000000000004";
const AGENT_E = "51000000-0000-4000-8000-000000000005";
const SOURCE_S1 = "52000000-0000-4000-8000-000000000001";
const SOURCE_S2 = "52000000-0000-4000-8000-000000000002";
const QUERIES_PAGE = "53000000-0000-4000-8000-000000000001";

interface CliResult {
  stdout: string;
  status: number;
}

/** Spawn a migration/seed script exactly as the runbook documents. */
function runScript(script: string, args: string[]): CliResult {
  try {
    const stdout = execFileSync(TSX, [script, ...args], {
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

function openRelay(dataDir: string): RelayStorage {
  return new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
}

/**
 * The sync server's hydration shape: restore the latest snapshot, then apply
 * every log envelope after it. Throws on any StoreError — the assertion IS
 * that the [snapshot + tail] replay converges clean.
 */
function hydrate(relay: RelayStorage, workspaceId: string, storePath: string): Store {
  const store = Store.openFile(storePath);
  const snapshot = relay.latestSnapshot(workspaceId);
  let afterSeq = 0;
  if (snapshot !== null) {
    const bytes = relay.readSnapshotData(snapshot.id);
    if (bytes === null) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
    store.restore(new Uint8Array(bytes));
    afterSeq = snapshot.up_to_seq;
  }
  let cursor = afterSeq;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

function authorsValues(store: Store, nodeId: string): Map<number, unknown> {
  const byIdx = new Map<number, unknown>();
  for (const row of visiblePropertyValueRows(store.database)) {
    if (row.property_schema_id !== AUTHORS_ID || row.node_id !== nodeId) continue;
    byIdx.set(row.idx, JSON.parse(row.value));
  }
  return byIdx;
}

function authorsMetadata(store: Store, nodeId: string, idx: number): unknown {
  for (const row of visiblePropertyValueRows(store.database)) {
    if (row.property_schema_id !== AUTHORS_ID || row.node_id !== nodeId || row.idx !== idx) continue;
    return row.metadata === null ? null : JSON.parse(row.metadata);
  }
  return undefined;
}

function linkedRefs(store: Store, nodeId: string): Set<string> {
  const refs = new Set<string>();
  for (const row of visiblePropertyValueRows(store.database)) {
    if (row.property_schema_id !== LINKED_AUTHORS_ID || row.node_id !== nodeId) continue;
    const ref = nodeRefOfValue(JSON.parse(row.value));
    if (ref !== null) refs.add(ref);
  }
  return refs;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "notees-authors-migrate-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function seed(): void {
  const result = runScript(SEED_SCRIPT, ["--data-dir", dataDir]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("scratch relay seeded");
}

describe("migrate-authors-to-text", () => {
  it("review focus #1: a pre-migration snapshot + the migrated tail converges with zero StoreError", () => {
    seed();

    // A device caught up BEFORE the migration: snapshot the drifted state.
    const relay = openRelay(dataDir);
    const preStore = hydrate(relay, WORKSPACE_MAIN, join(dataDir, "pre-migration-store.db"));
    relay.saveSnapshot(
      WORKSPACE_MAIN,
      PRE_MIGRATION_SNAPSHOT_ID,
      relay.maxHlc(WORKSPACE_MAIN),
      relay.latestSeq(WORKSPACE_MAIN),
      Buffer.from(preStore.snapshot()),
    );
    preStore.close();
    const preCount = relay.envelopeCount(WORKSPACE_MAIN);
    relay.close();

    // Dry run: full plan + the pre-ingest replay gate, ZERO envelopes written.
    const dry = runScript(MIGRATION_SCRIPT, ["--data-dir", dataDir, "--workspace", WORKSPACE_MAIN]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("8 envelope(s) built and protocol-validated");
    expect(dry.stdout).toContain("pre-ingest test-apply: all 8 envelope(s) applied clean");
    expect(dry.stdout).toContain('{"nodeId":"' + AGENT_E + '"} (target ' + AGENT_E + " gone)"); // the kept broken ref
    expect(dry.stdout).toContain("meaning-flip report: 1 saved view(s)");
    expect(dry.stdout).toContain("property:contains");
    expect(dry.stdout).toContain("dry run");
    expect(dry.stdout).not.toContain("ingested");
    const relayDry = openRelay(dataDir);
    expect(relayDry.envelopeCount(WORKSPACE_MAIN)).toBe(preCount);
    relayDry.close();

    // Apply: one ordered ingest (adds → flip → rewrites) + the script's own
    // verification, which now replays from OUR pre-migration snapshot.
    const apply = runScript(MIGRATION_SCRIPT, [
      "--data-dir", dataDir, "--workspace", WORKSPACE_MAIN, "--apply",
    ]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("ingested 8 envelope(s)");
    expect(apply.stdout).toContain("verify: 8 new envelope(s) read back");
    expect(apply.stdout).toContain("tail applied clean");

    // The replica, rebuilt in-process: restore the PRE-MIGRATION snapshot and
    // apply the migrated tail by hand. Any StoreError fails the test here —
    // an object value validated against the text schema would throw at
    // applyPropertySet's one-shape-per-type check.
    const relayAfter = openRelay(dataDir);
    expect(relayAfter.latestSnapshot(WORKSPACE_MAIN)?.id).toBe(PRE_MIGRATION_SNAPSHOT_ID);
    const store = hydrate(relayAfter, WORKSPACE_MAIN, join(dataDir, "replica-store.db"));

    // The schema converged: text-multi, the source scope preserved verbatim.
    const schemaRow = store.database
      .prepare("SELECT type, multi, scope_class_ids, target_class_filter FROM property_schema WHERE id = ?")
      .get(AUTHORS_ID) as {
      type: string;
      multi: number;
      scope_class_ids: string | null;
      target_class_filter: string | null;
    };
    expect(schemaRow.type).toBe("text");
    expect(schemaRow.multi).toBe(1);
    expect(JSON.parse(schemaRow.scope_class_ids!)).toEqual([SOURCE_ID]);
    // The controller ruling "type + multi only": the stored agent filter rides verbatim.
    expect(JSON.parse(schemaRow.target_class_filter!)).toEqual([SYSTEM_CLASS_UUIDS.agent]);

    // The PG5 element rewrites (in-place identity swaps) + metadata verbatim.
    const s1 = authorsValues(store, SOURCE_S1);
    expect(s1.get(0)).toBe("Lovelace, Ada"); // familyName + givenName
    expect(s1.get(1)).toBe("Lord Byron"); // title fallback (agent node, no name properties)
    expect(authorsMetadata(store, SOURCE_S1, 1)).toEqual({ note: "seed-metadata-rides-verbatim" });
    expect(s1.get(2)).toEqual({ nodeId: AGENT_E }); // broken ref keeps its value

    // The legacy positional rewrites — an archived agent's names still read.
    const s2 = authorsValues(store, SOURCE_S2);
    expect(s2.get(0)).toBe("Virgil"); // given-name-only keeps the one part
    expect(s2.get(1)).toBe("Arendt, Hannah"); // archived target, names over archive

    // The people-graph backlinks: every rewritten ref copied to linkedAuthors
    // (agentA was already linked — the partial corner must not duplicate).
    const s1Refs = linkedRefs(store, SOURCE_S1);
    expect(s1Refs.size).toBe(2);
    expect(s1Refs.has(AGENT_A)).toBe(true);
    expect(s1Refs.has(AGENT_B)).toBe(true);
    expect(s1Refs.has(AGENT_E)).toBe(false); // the broken ref is never copied
    expect(linkedRefs(store, SOURCE_S2)).toEqual(new Set([AGENT_C, AGENT_D]));

    // The meaning flip: the pre-migration saved view (a property condition on
    // …0012) still runs and matches the migrated source by UUID — reading a
    // name-string now.
    const host = store.database
      .prepare("SELECT content FROM node WHERE id = ?")
      .get(QUERIES_PAGE) as { content: string };
    const tokens = JSON.parse(host.content) as Array<{ type?: string; queryAst?: unknown }>;
    const propertyView = tokens.find(
      (token) => token.type === "query" && JSON.stringify(token.queryAst).includes(AUTHORS_ID),
    );
    expect(propertyView).toBeDefined();
    const result = runQuery(store, parseQueryAst(propertyView!.queryAst));
    expect(result.ids).toContain(SOURCE_S1);

    store.close();
    relayAfter.close();
  });

  it("review focus #1 (export slice): a pre-flip object authors value replaying late (older HLC) does not throw and loses the element LWW", () => {
    seed();
    const applied = runScript(MIGRATION_SCRIPT, [
      "--data-dir", dataDir, "--workspace", WORKSPACE_MAIN, "--apply",
    ]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("ingested 8 envelope(s)");

    const relay = openRelay(dataDir);
    const store = hydrate(relay, WORKSPACE_MAIN, join(dataDir, "stale-replay-store.db"));
    const row = visiblePropertyValueRows(store.database).find(
      (candidate) =>
        candidate.property_schema_id === AUTHORS_ID && candidate.node_id === SOURCE_S1 && candidate.idx === 0,
    )!;
    expect(JSON.parse(row.value)).toBe("Lovelace, Ada");

    // A device authored this authors element BEFORE the flip (an object
    // {nodeId} value under the then-object schema) and syncs late — the
    // envelope arrives after the migrated tail. Replaying it on the
    // converged store must not throw (a text schema accepts a {nodeId}
    // shape — the same leniency that keeps broken refs riding), and the
    // element LWW must keep the migrated text value: the stale write loses.
    const stale = newEnvelope({
      workspaceId: WORKSPACE_MAIN,
      actorId: "01920000-0000-7000-8000-0000000000b8",
      deviceId: "stale-pre-flip-device",
      client: "stale-pre-flip-device",
      hlc: { physical: 1_000_000_000_000, logical: 0 }, // years older than the migration envelopes
      affectedNodeIds: [SOURCE_S1],
      opType: "property.set",
      payload: {
        objectId: SOURCE_S1,
        propertySchemaId: AUTHORS_ID,
        elementId: row.id,
        value: { nodeId: AGENT_B },
      },
    });
    expect(() => store.apply(stale)).not.toThrow();

    const after = visiblePropertyValueRows(store.database).find(
      (candidate) =>
        candidate.property_schema_id === AUTHORS_ID && candidate.node_id === SOURCE_S1 && candidate.idx === 0,
    )!;
    expect(JSON.parse(after.value)).toBe("Lovelace, Ada");

    store.close();
    relay.close();
  });

  it("a second run plans nothing (idempotent)", () => {
    seed();
    const first = runScript(MIGRATION_SCRIPT, [
      "--data-dir", dataDir, "--workspace", WORKSPACE_MAIN, "--apply",
    ]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("ingested 8 envelope(s)");

    const second = runScript(MIGRATION_SCRIPT, [
      "--data-dir", dataDir, "--workspace", WORKSPACE_MAIN,
    ]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to migrate");
    expect(second.stdout).not.toContain("envelope(s) built");
  });

  it("converged and empty workspaces plan nothing", () => {
    seed();
    for (const workspaceId of [WORKSPACE_CONVERGED, WORKSPACE_EMPTY]) {
      const result = runScript(MIGRATION_SCRIPT, ["--data-dir", dataDir, "--workspace", workspaceId]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("nothing to migrate");
      expect(result.stdout).not.toContain("envelope(s) built");
    }
  });

  it("the scratch harness hard-refuses a non-/tmp data dir", () => {
    const result = runScript(SEED_SCRIPT, ["--data-dir", "/var/tmp/notees-authors-refusal-probe"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("only accepts --data-dir under /tmp");
  });
});
