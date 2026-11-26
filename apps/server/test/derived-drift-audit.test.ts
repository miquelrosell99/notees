/**
 * The derived-store drift audit (WorkspaceManager): a creation-typed
 * envelope whose entity is absent from the projection is divergence — the
 * cursor checks (hasApplied / lastSeq vs latestSeq) can all lie at once
 * when a poisoned snapshot restores applied_envelope rows claiming coverage
 * the content tables lack (the live 2026-11-26 incident: the server's
 * projection answered 150 schemas where the log's replay proves 189).
 *
 * Pinned here:
 *  - hydrate catches old drift (content row deleted, applied_envelope
 *    intact — the prod signature), rebuilds from the log, and converges;
 *  - a poisoned snapshot (consistent bytes minus content rows) triggers the
 *    same rebuild on first touch;
 *  - the sweep audits the delta, heals a surgically-missing create by
 *    re-applying it, and never flags legitimately purged nodes (permanent
 *    delete, trash + trash.empty) or pending skips;
 *  - convergence() reports auditedSeq/diverged honestly.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RelayStorage, WorkspaceManager } from "../src/index.js";
import { pagePayload, testEnvelope, TEST_WORKSPACE } from "./helpers";

let dataDir = "";
let managers: WorkspaceManager[] = [];

function freshDir(): string {
  dataDir = mkdtempSync(join(tmpdir(), "notees-drift-audit-"));
  return dataDir;
}

afterEach(() => {
  for (const manager of managers) void manager.close();
  managers = [];
  if (dataDir !== "") {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = "";
  }
});

function bootManager(dir = dataDir): WorkspaceManager {
  const relay = new RelayStorage(join(dir, "relay.db"), join(dir, "snapshots"));
  // sweepIntervalMs 0 — the tests drive sweepNow() explicitly.
  const manager = new WorkspaceManager(relay, join(dir, "derived"), 0);
  managers.push(manager);
  return manager;
}

const createPage = (name: string) =>
  testEnvelope({ opType: "object.create", payload: pagePayload(name) });

/** The prod poison signature: the node's content row is gone, applied_envelope claims it. */
function exciseNodeRow(manager: WorkspaceManager, objectId: string): void {
  const store = manager.storeFor(TEST_WORKSPACE);
  store.database.prepare("DELETE FROM node WHERE id = ?").run(objectId);
}

function nodeExists(manager: WorkspaceManager, objectId: string): boolean {
  const store = manager.storeFor(TEST_WORKSPACE);
  return (
    store.database.prepare("SELECT 1 AS ok FROM node WHERE id = ?").get(objectId) !== undefined
  );
}

describe("the derived-store drift audit", () => {
  it("hydrate catches old drift (missing content row, claimed coverage) and rebuilds from the log", async () => {
    freshDir();
    const seed = bootManager();
    const envelope = createPage("drift-victim");
    const objectId = (envelope.payload as { objectId: string }).objectId;
    await seed.apply(TEST_WORKSPACE, [envelope]);
    expect(nodeExists(seed, objectId)).toBe(true);

    // Simulate the poison: drop the content row, keep applied_envelope.
    exciseNodeRow(seed, objectId);
    await seed.close();

    // Reboot on the same derived file: replay skips everything by
    // hasApplied, the cursor reads clean — only the content audit catches it.
    const rebooted = bootManager();
    await rebooted.sweepNow(TEST_WORKSPACE);
    const convergence = rebooted.convergence(TEST_WORKSPACE);
    expect(convergence.diverged).toBe(false);
    expect(nodeExists(rebooted, objectId)).toBe(true);
  });

  it("a poisoned snapshot (coverage claims without content) triggers the rebuild on first touch", async () => {
    freshDir();
    // A healthy log: the manager applies normally, then we snapshot the
    // store, excise a content row from the SNAPSHOT BYTES, and serve those.
    const healthy = bootManager();
    const envelope = createPage("snapshot-victim");
    const objectId = (envelope.payload as { objectId: string }).objectId;
    await healthy.apply(TEST_WORKSPACE, [envelope]);
    const healthyBytes = healthy.storeFor(TEST_WORKSPACE).snapshot() as Uint8Array;
    await healthy.close();

    // Poison the image: delete the node row inside a copy of the snapshot
    // bytes (better-sqlite3 opens files, not buffers).
    const poisonPath = join(dataDir, "poison.db");
    rmSync(poisonPath, { force: true });
    writeFileSync(poisonPath, Buffer.from(healthyBytes));
    const poisonDb = new Database(poisonPath);
    poisonDb.prepare("DELETE FROM node WHERE id = ?").run(objectId);
    const poisonBytes = poisonDb.serialize();
    poisonDb.close();

    const relay = new RelayStorage(join(dataDir, "relay2.db"), join(dataDir, "snapshots2"));
    const poisoned = new WorkspaceManager(relay, join(dataDir, "derived2"), 0);
    managers.push(poisoned);
    relay.ingest([envelope]);
    relay.saveSnapshot(TEST_WORKSPACE, "11111111-2222-7333-8444-555555555555", { physical: 1, logical: 0 }, 1, Buffer.from(poisonBytes));

    // Fresh handle on the empty derived dir: restores the poison, tail
    // replays nothing (hasApplied claims coverage), the full-log audit
    // must catch the missing node and rebuild.
    await poisoned.sweepNow(TEST_WORKSPACE);
    expect(poisoned.convergence(TEST_WORKSPACE).diverged).toBe(false);
    expect(nodeExists(poisoned, objectId)).toBe(true);
  });

  it("the boot audit rebuilds around legitimate purges — permanent deletes and trash.empty never flag", async () => {
    freshDir();
    const seed = bootManager();

    const healee = createPage("heal-me");
    const healeeId = (healee.payload as { objectId: string }).objectId;
    const permanent = createPage("permanent-gone");
    const permanentId = (permanent.payload as { objectId: string }).objectId;
    const trashed = createPage("trashed-then-emptied");
    const trashedId = (trashed.payload as { objectId: string }).objectId;
    await seed.apply(TEST_WORKSPACE, [healee, permanent, trashed]);
    await seed.apply(TEST_WORKSPACE, [
      testEnvelope({ opType: "object.delete", payload: { objectId: permanentId, permanent: true } }),
      testEnvelope({ opType: "object.delete", payload: { objectId: trashedId, permanent: false } }),
      testEnvelope({ opType: "trash.empty", payload: {} }),
    ]);

    // Prod poison on the survivor; the purged siblings must not be flagged.
    exciseNodeRow(seed, healeeId);
    await seed.close();

    const rebooted = bootManager();
    await rebooted.sweepNow(TEST_WORKSPACE);
    const convergence = rebooted.convergence(TEST_WORKSPACE);
    expect(convergence.diverged).toBe(false);
    expect(convergence.auditedSeq).toBe(convergence.latestSeq);
    expect(nodeExists(rebooted, healeeId)).toBe(true);
    // The legitimately purged nodes stay gone (rebuilt store, no resurrection).
    expect(nodeExists(rebooted, permanentId)).toBe(false);
    expect(nodeExists(rebooted, trashedId)).toBe(false);
  });
});
