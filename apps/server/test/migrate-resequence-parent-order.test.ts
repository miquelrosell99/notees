/**
 * migrate-resequence-parent-order.mts end-to-end: a synthetic relay seeded with a
 * deliberately racing batch (a child create ingested BEFORE its parent's
 * create, both embedded — the live Notas shape) is resequenced by the
 * operator script exactly as the runbook documents. The birth payloads must
 * ride untouched (an embedded block can only receive a block parent at
 * birth — ordering alone is repaired), the window is a pure permutation
 * inside its range, and strict replay of the result converges to the
 * converged tree.
 *
 * Workspaces:
 *  - WS_RACE: child C before block B before host page P, plus an unrelated
 *    create U between them (stability) and a pre-saved snapshot INSIDE the
 *    window (must be backed up + dropped).
 *  - WS_STRIP: a dead-edge offender (child created out-of-order, then
 *    re-created parentless — converged parentless) → strip-only path, no
 *    resequencing window.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";

import { RelayStorage } from "../src/relay-storage.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const SCRIPT = "../../scripts/migrate-resequence-parent-order.mts";

const WS_RACE = "4b7d1a00-1111-4000-8000-0000000000c1";
const WS_STRIP = "4b7d1a00-1111-4000-8000-0000000000c2";
const WS_QUAR = "4b7d1a00-1111-4000-8000-0000000000c3"; // no offenders — conformance poison only

const U_UNRELATED = "52000000-0000-4000-8000-0000000000c1";
const C_CHILD = "52000000-0000-4000-8000-0000000000c2";
const B_BLOCK = "52000000-0000-4000-8000-0000000000c3";
const P_HOST = "52000000-0000-4000-8000-0000000000c4";
const C2_CHILD = "52000000-0000-4000-8000-0000000000c5";
const P2_HOST = "52000000-0000-4000-8000-0000000000c6";
const Q_HOST = "52000000-0000-4000-8000-0000000000c7";
const Q_BLOCK = "52000000-0000-4000-8000-0000000000c8";
const Q_STANDALONE = "52000000-0000-4000-8000-0000000000c9";

const ACTOR = "01920000-0000-7000-8000-0000000000a4";

interface CliResult {
  stdout: string;
  status: number;
}

function runScript(args: string[]): CliResult {
  try {
    const stdout = execFileSync(TSX, [SCRIPT, ...args], {
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

let clock = 1_727_200_000_000;

function seed(
  relay: RelayStorage,
  workspaceId: string,
  opType: string,
  payload: Record<string, unknown>,
  affected: string[],
): Envelope {
  const physical = (clock += 100);
  const envelope = newEnvelope({
    workspaceId,
    actorId: ACTOR,
    deviceId: "seed-device",
    hlc: { physical, logical: 0 },
    affectedNodeIds: affected,
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
  const { savedIds } = relay.ingest([envelope]);
  if (savedIds.length !== 1) throw new Error("seed ingest failed");
  return envelope;
}

function seedAll(dataDir: string): void {
  const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));

  // WS_RACE — the live shape: C (embedded) created BEFORE its parent B (an
  // embedded block under the host page P); U is an unrelated create between
  // the racing envelopes (stability witness).
  seed(relay, WS_RACE, "object.create", {
    objectId: C_CHILD, parentId: B_BLOCK, isEmbedded: true,
    contentAst: [{ type: "text", text: "racing child" }],
  }, [C_CHILD]);
  seed(relay, WS_RACE, "object.create", {
    objectId: U_UNRELATED, isEmbedded: false,
    contentAst: [{ type: "text", text: "unrelated" }],
  }, [U_UNRELATED]);
  seed(relay, WS_RACE, "object.create", {
    objectId: P_HOST, isEmbedded: false,
    contentAst: [{ type: "text", text: "host page" }],
  }, [P_HOST]);
  seed(relay, WS_RACE, "object.create", {
    objectId: B_BLOCK, parentId: P_HOST, isEmbedded: true,
    contentAst: [{ type: "text", text: "the block" }],
  }, [B_BLOCK]);

  // WS_STRIP — a dead edge: C2 created out-of-order under P2, then the
  // racing batch re-issued C2 WITHOUT a parent (the parentless birth the
  // tolerant projection converged on). The derived DB below records that.
  seed(relay, WS_STRIP, "object.create", {
    objectId: C2_CHILD, parentId: P2_HOST, isEmbedded: true,
    contentAst: [{ type: "text", text: "dead edge" }],
  }, [C2_CHILD]);
  seed(relay, WS_STRIP, "object.create", {
    objectId: P2_HOST, isEmbedded: false,
    contentAst: [{ type: "text", text: "host" }],
  }, [P2_HOST]);
  seed(relay, WS_STRIP, "object.create", {
    objectId: C2_CHILD, isEmbedded: true,
    contentAst: [{ type: "text", text: "dead edge" }],
  }, [C2_CHILD]);

  // WS_QUAR — NO ordering offenders; one conformance-poison envelope: a move
  // taking a STANDALONE node under an embedded block (the strict guard can
  // never apply it). The quarantine arm stands alone here.
  seed(relay, WS_QUAR, "object.create", {
    objectId: Q_HOST, isEmbedded: false,
    contentAst: [{ type: "text", text: "quar host" }],
  }, [Q_HOST]);
  seed(relay, WS_QUAR, "object.create", {
    objectId: Q_BLOCK, parentId: Q_HOST, isEmbedded: true,
    contentAst: [{ type: "text", text: "quar block" }],
  }, [Q_BLOCK]);
  seed(relay, WS_QUAR, "object.create", {
    objectId: Q_STANDALONE, isEmbedded: false,
    contentAst: [{ type: "text", text: "standalone page" }],
  }, [Q_STANDALONE]);
  seed(relay, WS_QUAR, "object.move", {
    objectId: Q_STANDALONE, parentId: Q_BLOCK,
  }, [Q_STANDALONE]);

  // A snapshot INSIDE the racing window (up_to_seq = 4 ≥ windowStart) — the
  // apply must back it up and drop it.
  const projection = Store.openFile(join(dataDir, "pre-race-store.db"));
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(WS_RACE, cursor, 10_000);
    for (const envelope of page.envelopes) {
      try {
        projection.apply(envelope);
      } catch {
        // Tolerant — the racing create is the poison this test repairs.
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  relay.saveSnapshot(
    WS_RACE,
    "7a000000-0000-4000-8000-0000000000c1",
    relay.maxHlc(WS_RACE),
    relay.latestSeq(WS_RACE),
    Buffer.from(projection.snapshot()),
  );
  projection.close();

  // The derived DBs (the authority): the tolerant projection per workspace.
  mkdirDerived(dataDir, relay, WS_STRIP);
  relay.close();
}

/** Materialize a server-shaped derived DB for a workspace (tolerant replay). */
function mkdirDerived(dataDir: string, relay: RelayStorage, workspaceId: string): void {
  mkdirSync(join(dataDir, "derived"), { recursive: true });
  const store = Store.openFile(join(dataDir, "derived", `${workspaceId}.db`));
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) {
      try {
        store.apply(envelope);
      } catch {
        // Tolerant projection — poison skipped.
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  store.close();
}

/** The strict hydration shape: any StoreError fails the test. */
function strictHydrate(relay: RelayStorage, workspaceId: string, storePath: string): Store {
  const store = Store.openFile(storePath);
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "notees-resequence-"));
  seedAll(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("migrate-resequence-parent-order", () => {
  it("dry run prints the window + sample assignments and writes nothing", () => {
    const relayBefore = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    const orderBefore = relayBefore.catchUp(WS_RACE, 0, 100).envelopes.map((e) => e.id);
    relayBefore.close();

    const dry = runScript(["--data-dir", dataDir, "--workspace", WS_RACE]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("1 candidate(s)");
    expect(dry.stdout).toContain("window [1..4]");
    expect(dry.stdout).toContain("4 envelope(s)");
    expect(dry.stdout).toContain("a permutation inside the range");
    expect(dry.stdout).toContain("dry run");

    const relayAfter = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    expect(relayAfter.catchUp(WS_RACE, 0, 100).envelopes.map((e) => e.id)).toEqual(orderBefore);
    relayAfter.close();
  });

  it("--apply resequences the window: payloads byte-identical, strict replay converges, embedding preserved", () => {
    const relayBefore = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    const childEnvelope = relayBefore
      .allEnvelopes(WS_RACE)
      .find((envelope) => (envelope.payload as { objectId?: string }).objectId === C_CHILD)!;
    const childPayloadBefore = JSON.stringify(childEnvelope.payload);
    const childHlcBefore = JSON.stringify(childEnvelope.hlc);
    relayBefore.close();

    const apply = runScript(["--data-dir", dataDir, "--workspace", WS_RACE, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("backup:");
    expect(apply.stdout).toContain("resequenced window [1..4]");
    expect(apply.stdout).toContain("restore_epoch bumped to 1");
    expect(apply.stdout).toContain("verify: strict replay clean");
    expect(apply.stdout).toContain("zero out-of-order creates");
    expect(apply.stdout).toContain("inside/after the window"); // stale snapshot dropped

    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));

    // The stale snapshot was backed up + dropped.
    expect(relay.latestSnapshot(WS_RACE)).toBeNull();

    // The new order: U (stability witness) stays first; P before B before C.
    const order = relay.catchUp(WS_RACE, 0, 100).envelopes;
    expect(order.map((envelope) => (envelope.payload as { objectId?: string }).objectId)).toEqual([
      U_UNRELATED,
      P_HOST,
      B_BLOCK,
      C_CHILD,
    ]);

    // Payloads and HLCs untouched — the birth payload (isEmbedded:true,
    // parentId) is the whole point of resequencing over strip+move.
    const childAfter = relay
      .allEnvelopes(WS_RACE)
      .find((envelope) => (envelope.payload as { objectId?: string }).objectId === C_CHILD)!;
    expect(JSON.stringify(childAfter.payload)).toBe(childPayloadBefore);
    expect(JSON.stringify(childAfter.hlc)).toBe(childHlcBefore);

    // Strict replay converges to the converged tree with embedding intact.
    const store = strictHydrate(relay, WS_RACE, join(dataDir, `replica-${WS_RACE}.db`));
    const rowOf = (id: string) =>
      store.database.prepare("SELECT parent_id, is_embedded FROM node WHERE id = ?").get(id) as
        | { parent_id: string | null; is_embedded: number }
        | undefined;
    expect(rowOf(C_CHILD)?.parent_id).toBe(B_BLOCK);
    expect(rowOf(C_CHILD)?.is_embedded).toBe(1); // the block-role birth survived
    expect(rowOf(B_BLOCK)?.parent_id).toBe(P_HOST);
    store.close();
    relay.close();

    expect(readdirSync(dataDir).some((name) => name.startsWith("relay.db.bak-"))).toBe(true);
  });

  it("strip-only workspace: dead-edge create stripped in place, no resequencing window", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WS_STRIP, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("0 candidate(s) (birth edge true — order repair), 1 strip-only (dead edge)");
    expect(apply.stdout).toContain("stripped parentId from 1 dead-edge create envelope(s)");
    expect(apply.stdout).not.toContain("resequenced window");
    expect(apply.stdout).toContain("restore_epoch bumped to 1");
    expect(apply.stdout).toContain("verify: strict replay clean");

    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    const store = strictHydrate(relay, WS_STRIP, join(dataDir, `replica-${WS_STRIP}.db`));
    const row = store.database
      .prepare("SELECT parent_id FROM node WHERE id = ?")
      .get(C2_CHILD) as { parent_id: string | null } | undefined;
    expect(row?.parent_id).toBeNull(); // converged parentless, exactly
    store.close();
    relay.close();
  });

  it("a second run plans nothing (idempotent)", () => {
    const first = runScript(["--data-dir", dataDir, "--workspace", WS_RACE, "--apply"]);
    expect(first.status).toBe(0);

    const second = runScript(["--data-dir", dataDir, "--workspace", WS_RACE, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to resequence");
    expect(second.stdout).not.toContain("resequenced window");
  });

  it("quarantine-only workspace: no offenders, one never-applicable move — diagnosed, deleted, verified", () => {
    const dry = runScript(["--data-dir", dataDir, "--workspace", WS_QUAR]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("nothing to resequence");
    expect(dry.stdout).toContain("quarantine: 1 tail envelope(s)");
    expect(dry.stdout).toContain("dry run");

    const apply = runScript(["--data-dir", dataDir, "--workspace", WS_QUAR, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("quarantined (deleted) 1 never-applicable envelope(s)");
    expect(apply.stdout).toContain("verify: strict replay clean");
    expect(apply.stdout).toContain("zero out-of-order creates");
    expect(apply.stdout).toContain("restore_epoch bumped to 1");

    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    const moves = relay.allEnvelopes(WS_QUAR).filter((envelope) => envelope.opType === "object.move");
    expect(moves.length).toBe(0); // the poison move is gone
    const store = strictHydrate(relay, WS_QUAR, join(dataDir, `replica-${WS_QUAR}.db`));
    const row = store.database
      .prepare("SELECT parent_id FROM node WHERE id = ?")
      .get(Q_STANDALONE) as { parent_id: string | null } | undefined;
    expect(row?.parent_id).toBeNull(); // converged parentless, unchanged
    store.close();
    relay.close();

    const third = runScript(["--data-dir", dataDir, "--workspace", WS_QUAR, "--apply"]);
    expect(third.status).toBe(0);
    expect(third.stdout).toContain("nothing to resequence");
    expect(third.stdout).not.toContain("quarantined");
  });
});
