/**
 * migrate-repair-parent-order.mts end-to-end (the 2026-10-26 parent-order
 * audit): a synthetic relay seeded with deliberately out-of-order
 * `object.create` pairs is repaired by the operator script exactly as the
 * runbook documents — dry run writes nothing, --apply rewrites the offending
 * create in place + appends one deterministic-id `object.move` at the tail,
 * and a strict in-process replay of the repaired log converges with the child
 * under its parent. A block-parent offender (the move-guard case: an embedded
 * parent can never receive a first-parenting move) must make --apply refuse
 * WITHOUT writing anything.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope } from "@notees/protocol";
import { Store } from "@notees/store";

import { RelayStorage } from "../src/relay-storage.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const SCRIPT = "../../scripts/migrate-repair-parent-order.mts";

// Two workspaces in ONE relay (the live shape — one file, many workspaces).
const WS_PAGE = "4b7d1a00-1111-4000-8000-0000000000a1"; // clean repair: page parent
const WS_BLOCK = "4b7d1a00-1111-4000-8000-0000000000a2"; // guard risk: embedded-block parent
const WS_DUP = "4b7d1a00-1111-4000-8000-0000000000a3"; // two out-of-order creates, SAME child
const WS_RESUME = "4b7d1a00-1111-4000-8000-0000000000a4"; // crashed run: moves in the log, epoch 0

const P_PAGE = "52000000-0000-4000-8000-0000000000a1";
const C_PAGE = "52000000-0000-4000-8000-0000000000a2";
const P_BLOCKHOST = "52000000-0000-4000-8000-0000000000b1";
const B_BLOCK = "52000000-0000-4000-8000-0000000000b2";
const C_BLOCK = "52000000-0000-4000-8000-0000000000b3";
const P_DUP = "52000000-0000-4000-8000-0000000000d1";
const C_DUP = "52000000-0000-4000-8000-0000000000d2";
const P_RESUME = "52000000-0000-4000-8000-0000000000e1";
const C_RESUME = "52000000-0000-4000-8000-0000000000e2";

const ACTOR = "01920000-0000-7000-8000-0000000000a4";
const REPAIR_DEVICE = "migrate-repair-parent-order";

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

function seedEnvelope(
  relay: RelayStorage,
  workspaceId: string,
  opType: string,
  payload: Record<string, unknown>,
  affected: string[],
): void {
  const physical = (clock += 100);
  relay.ingest([
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: "seed-device",
      hlc: { physical, logical: 0 },
      affectedNodeIds: affected,
      opType,
      payload,
      timestamp: new Date(physical).toISOString(),
    }),
  ]);
}

function seed(dataDir: string): void {
  const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));

  // WS_PAGE — the racing-import shape: the child create lands BEFORE its
  // parent's create, and a duplicate batch re-issues the child create after
  // (the idempotent re-create cascade that let tolerant replicas self-heal).
  seedEnvelope(relay, WS_PAGE, "object.create", {
    objectId: C_PAGE,
    parentId: P_PAGE,
    isEmbedded: true,
    contentAst: [{ type: "text", text: "racing child" }],
  }, [C_PAGE]);
  seedEnvelope(relay, WS_PAGE, "object.create", {
    objectId: P_PAGE,
    isEmbedded: false,
    contentAst: [{ type: "text", text: "the parent page" }],
  }, [P_PAGE]);
  seedEnvelope(relay, WS_PAGE, "object.create", {
    objectId: C_PAGE,
    parentId: P_PAGE,
    isEmbedded: true,
    contentAst: [{ type: "text", text: "racing child" }],
  }, [C_PAGE]);

  // WS_BLOCK — the same race, but the parent is an EMBEDDED BLOCK: the
  // appended first-parenting move is rejected by the move guard, so --apply
  // must refuse without writing.
  seedEnvelope(relay, WS_BLOCK, "object.create", {
    objectId: P_BLOCKHOST,
    isEmbedded: false,
    contentAst: [{ type: "text", text: "host page" }],
  }, [P_BLOCKHOST]);
  seedEnvelope(relay, WS_BLOCK, "object.create", {
    objectId: C_BLOCK,
    parentId: B_BLOCK,
    isEmbedded: true,
    contentAst: [{ type: "text", text: "child under a block" }],
  }, [C_BLOCK]);
  seedEnvelope(relay, WS_BLOCK, "object.create", {
    objectId: B_BLOCK,
    parentId: P_BLOCKHOST,
    isEmbedded: true,
    contentAst: [{ type: "text", text: "the embedded block" }],
  }, [B_BLOCK]);

  // WS_DUP — the live test-workspace incident: the racing import left TWO
  // out-of-order creates for the SAME child. Both must be stripped; exactly
  // ONE move may be appended (the deterministic envelope ids are keyed by
  // child — a second move collides and ingest drops it).
  seedEnvelope(relay, WS_DUP, "object.create", {
    objectId: C_DUP,
    parentId: P_DUP,
    isEmbedded: true,
    contentAst: [{ type: "text", text: "dup child" }],
  }, [C_DUP]);
  seedEnvelope(relay, WS_DUP, "object.create", {
    objectId: C_DUP,
    parentId: P_DUP,
    isEmbedded: true,
    contentAst: [{ type: "text", text: "dup child" }],
  }, [C_DUP]);
  seedEnvelope(relay, WS_DUP, "object.create", {
    objectId: P_DUP,
    isEmbedded: false,
    contentAst: [{ type: "text", text: "dup parent" }],
  }, [P_DUP]);

  // WS_RESUME — a run that CRASHED between the move ingest and the epoch
  // bump: the strips and the repair move are already in the log (issued by
  // the migration device), restore_epoch is still 0. A re-run must execute
  // the snapshot/epoch/verify tail stages, not short-circuit.
  seedEnvelope(relay, WS_RESUME, "object.create", {
    objectId: C_RESUME,
    isEmbedded: true,
    contentAst: [{ type: "text", text: "resumed child" }],
  }, [C_RESUME]);
  seedEnvelope(relay, WS_RESUME, "object.create", {
    objectId: P_RESUME,
    isEmbedded: false,
    contentAst: [{ type: "text", text: "resumed parent" }],
  }, [P_RESUME]);
  seedEnvelope(relay, WS_RESUME, "object.move", {
    objectId: C_RESUME,
    parentId: P_RESUME,
  }, [C_RESUME]); // deviceId set below
  relay.close();

  // Rewrite the last envelope's device/client to the migration device's
  // (ingest is immutable — re-ingest under the repair device).
  const relay2 = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
  const move = relay2
    .allEnvelopes(WS_RESUME)
    .find((envelope) => envelope.opType === "object.move")!;
  relay2.ingest([
    {
      ...move,
      id: "7a000000-0000-4000-8000-0000000000e9",
      deviceId: REPAIR_DEVICE,
      client: REPAIR_DEVICE,
    },
  ]);
  relay2.close();
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
  dataDir = mkdtempSync(join(tmpdir(), "notees-repair-parent-order-"));
  seed(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("migrate-repair-parent-order", () => {
  it("dry run prints the full offender plan and writes nothing", () => {
    const relayBefore = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    const countBefore = relayBefore.envelopeCount(WS_PAGE) + relayBefore.envelopeCount(WS_BLOCK);
    relayBefore.close();

    const dry = runScript(["--data-dir", dataDir, "--all"]);
    expect(dry.status).toBe(0);
    // The full list: seq, child, parent, parentSeq for both workspaces.
    expect(dry.stdout).toContain(`child ${C_PAGE}`);
    expect(dry.stdout).toContain(`parent ${P_PAGE}`);
    expect(dry.stdout).toContain(`child ${C_BLOCK}`);
    expect(dry.stdout).toContain(`parent ${B_BLOCK}`);
    expect(dry.stdout).toContain("GUARD RISK");
    expect(dry.stdout).toContain("treat-as-main on first parenting");
    expect(dry.stdout).toContain("dry run");
    expect(dry.stdout).not.toContain("rewrote");

    const relayAfter = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    expect(relayAfter.envelopeCount(WS_PAGE) + relayAfter.envelopeCount(WS_BLOCK)).toBe(countBefore);
    relayAfter.close();
  });

  it("--apply repairs the page-parent workspace: rewrite + tail move + strict replay converge", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WS_PAGE, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("backup:");
    expect(apply.stdout).toContain("rewrote 1 create envelope(s) in place");
    expect(apply.stdout).toContain("appended 1 object.move envelope(s)");
    expect(apply.stdout).toContain("restore_epoch bumped to 1");
    expect(apply.stdout).toContain("verify: strict replay clean");
    expect(apply.stdout).toContain("zero out-of-order creates");

    // The repaired log replays STRICTLY (the pre-ingest migration gate) and
    // the child lands under its parent.
    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    const store = strictHydrate(relay, WS_PAGE, join(dataDir, `replica-${WS_PAGE}.db`));
    const row = store.database
      .prepare("SELECT parent_id, is_embedded FROM node WHERE id = ?")
      .get(C_PAGE) as { parent_id: string | null; is_embedded: number };
    expect(row.parent_id).toBe(P_PAGE);
    // The treat-as-main acquisition on first parenting:
    // the move parents the formerly-parentless node and acquires the
    // standalone claim — parent restored, embedding bit flipped, content
    // stringified at the promotion boundary.
    expect(row.is_embedded).toBe(0);
    store.close();
    relay.close();

    // The backup carries the pre-relay bytes (naming: relay.db.bak-<stamp>).
    expect(readdirSync(dataDir).some((name) => name.startsWith("relay.db.bak-"))).toBe(true);
  });

  it("a second run plans nothing (idempotent — the rewrites and the moves both re-scan clean)", () => {
    const first = runScript(["--data-dir", dataDir, "--workspace", WS_PAGE, "--apply"]);
    expect(first.status).toBe(0);

    const second = runScript(["--data-dir", dataDir, "--workspace", WS_PAGE, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to repair");
    expect(second.stdout).not.toContain("rewrote");
  });

  it("--apply refuses the block-parent workspace: move-guard preflight, nothing written", () => {
    const relayBefore = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    const countBefore = relayBefore.envelopeCount(WS_BLOCK);
    const offenderPayload = relayBefore
      .allEnvelopes(WS_BLOCK)
      .find((envelope) => envelope.opType === "object.create")!.payload;
    relayBefore.close();

    const apply = runScript(["--data-dir", dataDir, "--workspace", WS_BLOCK, "--apply"]);
    expect(apply.status).not.toBe(0);
    expect(apply.stdout).toContain("GUARD RISK");
    expect(apply.stdout).toContain("Refusing to write");
    expect(apply.stdout).toContain("refusing to write (nothing was modified)");

    const relayAfter = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    expect(relayAfter.envelopeCount(WS_BLOCK)).toBe(countBefore);
    const untouched = relayAfter
      .allEnvelopes(WS_BLOCK)
      .find((envelope) => envelope.opType === "object.create")!.payload;
    expect(untouched).toEqual(offenderPayload);
    relayAfter.close();
  });

  it("duplicate out-of-order creates for the same child: both stripped, exactly ONE move (the deterministic-id collision incident)", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WS_DUP, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("rewrote 2 create envelope(s) in place");
    expect(apply.stdout).toContain("appended 1 object.move envelope(s)");
    expect(apply.stdout).toContain("verify: strict replay clean");

    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    const moves = relay
      .allEnvelopes(WS_DUP)
      .filter((envelope) => envelope.opType === "object.move" && envelope.deviceId === REPAIR_DEVICE);
    expect(moves.length).toBe(1);
    const store = strictHydrate(relay, WS_DUP, join(dataDir, `replica-${WS_DUP}.db`));
    const row = store.database
      .prepare("SELECT parent_id FROM node WHERE id = ?")
      .get(C_DUP) as { parent_id: string | null };
    expect(row.parent_id).toBe(P_DUP);
    store.close();
    relay.close();

    // The resume re-run executes the tail stages and leaves the epoch alone.
    const second = runScript(["--data-dir", dataDir, "--workspace", WS_DUP, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("1 prior repair move(s)");
    expect(second.stdout).toContain("restore_epoch already 1 — left unchanged");
    expect(second.stdout).toContain("verify: strict replay clean");
  });

  it("resume of a crashed run (moves in the log, epoch 0): tail stages execute, epoch bumps, verify passes", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WS_RESUME, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("nothing to repair — but 1 prior repair move(s) ride the log");
    expect(apply.stdout).toContain("restore_epoch was 0 with repair envelopes already in the log — bumped to 1");
    expect(apply.stdout).toContain("verify: strict replay clean");
    expect(apply.stdout).toContain("zero out-of-order creates");

    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    expect(relay.restoreEpoch(WS_RESUME)).toBe(1);
    const store = strictHydrate(relay, WS_RESUME, join(dataDir, `replica-${WS_RESUME}.db`));
    const row = store.database
      .prepare("SELECT parent_id FROM node WHERE id = ?")
      .get(C_RESUME) as { parent_id: string | null };
    expect(row.parent_id).toBe(P_RESUME);
    store.close();
    relay.close();
  });
});
