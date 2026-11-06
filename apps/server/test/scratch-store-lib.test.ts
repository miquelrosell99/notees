/**
 * The shared scratch-store lib (scripts/lib/scratch-store.ts) — the sealed
 * gate + the keyed-workspace guard every migrate script rides.
 *
 * `buildScratchStore` must be byte-compatible with the reference
 * implementation every migration script carried locally (extracted from
 * scripts/migrate-repeat-property.mts, 2026-11-06): the hydration shape the
 * sync server uses — latest snapshot (never when `sealed=1`) + full log tail,
 * encrypted payloads skipping the apply, StoreError skips counting as
 * pending, anything else throwing. The pins:
 *
 *  (a) a plaintext workspace (no snapshot, tail only) plans EXACTLY what a
 *      manual full-tail hydration plans — the lib's store is state-equivalent
 *      (planned through the repeat migration's planner, the rehearsal shape);
 *  (b) a SEALED latest snapshot (garbage bytes, `sealed=1`) is never restored
 *      — the build does NOT throw ("file is not a database") and replays the
 *      plaintext tail into the same plan (the sealed pin in
 *      migrate-repeat-property.test.ts, in-process);
 *  (c) the skip accounting: an encrypted tail envelope lands in the counts,
 *      `onSkip` fires ONCE with the counts, and stays silent when nothing
 *      skipped.
 *
 * `keyedWorkspaceIds` reads the `workspace_key` custody table (auth.ts) from
 * `<dataDir>/relay.db` READ-ONLY: the keyed ids after a `putWorkspaceKey`,
 * an empty set when the table is absent (a relay-only data dir) or the db
 * does not exist at all — never a throw.
 *
 * `refuseIfContentOnKeyed` throws the house refusal ONLY for a "content"-
 * class migration against a keyed workspace; a "scaffolding"-class run on a
 * keyed workspace and a content-class run on an unkeyed one pass silent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { chainNodeIds, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { AuthStorage } from "../src/auth.js";
import { RelayStorage } from "../src/relay-storage.js";

import { planRepeatPropertyMigration } from "../../../scripts/migrate-repeat-property.mts";
import {
  buildScratchStore,
  keyedWorkspaceIds,
  refuseIfContentOnKeyed,
} from "../../../scripts/lib/scratch-store.ts";

const WORKSPACE = "4b7d1a00-3333-4000-8000-0000000000a1";
const OTHER_WORKSPACE = "4b7d1a00-3333-4000-8000-0000000000a2";
const ACTOR = "51000000-0000-4000-8000-000000000099";
const DEVICE = "scratch-store-lib-test";

const EVENT_ID = SYSTEM_CLASS_UUIDS.event;
const EVENT_DATE_ID = SYSTEM_PROPERTY_UUIDS.eventDate;

const NODE_EVENT = "0192a000-0000-7000-8000-00000000e101";
const CHAIN = chainNodeIds("2026-07-06"); // a Monday — the weekly anchor
const DAY_EVENT = CHAIN.day;

/** A minimal pre-redesign workspace: one event whose date value recurs weekly. */
function fixtureEnvelopes(): Envelope[] {
  const envelopes: Envelope[] = [];
  let t = 1727200000000;
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

  push("class.create", { classId: EVENT_ID, contentAst: text("Event") }, [EVENT_ID]);
  push(
    "propertySchema.create",
    { propertySchemaId: EVENT_DATE_ID, name: "Event date", type: "datetime", scopeClassIds: [EVENT_ID] },
    [],
  );
  push("class.property.set", { classId: EVENT_ID, propertySchemaId: EVENT_DATE_ID }, [EVENT_ID]);
  push("object.create", { objectId: CHAIN.year }, [CHAIN.year]);
  push("object.create", { objectId: CHAIN.month, parentId: CHAIN.year }, [CHAIN.month]);
  push("object.create", { objectId: CHAIN.day, parentId: CHAIN.month }, [CHAIN.day]);
  push(
    "object.create",
    { objectId: NODE_EVENT, isEmbedded: false, classIds: [EVENT_ID], contentAst: text("E") },
    [NODE_EVENT],
  );
  push(
    "property.set",
    {
      objectId: NODE_EVENT,
      propertySchemaId: EVENT_DATE_ID,
      value: { nodeId: DAY_EVENT },
      idx: 0,
      metadata: { repeat: "weekly" },
    },
    [NODE_EVENT],
  );
  return envelopes;
}

/** One sealed envelope appended after the fixture (a keyed client's op). */
function sealedEnvelope(): Envelope {
  return newEnvelope({
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    deviceId: "keyed-client-device",
    hlc: { physical: 1727200010000, logical: 0 },
    affectedNodeIds: [NODE_EVENT],
    opType: "object.update",
    payload: { $e: { iv: "aXY", ct: "Y3Q" } },
  });
}

/** The sync server's hydration shape: snapshot (none here) + full tail. */
function hydrate(relay: RelayStorage, store: Store): void {
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(WORKSPACE, cursor, 10_000);
    for (const envelope of page.envelopes) {
      if (typeof envelope.payload === "object" && envelope.payload !== null && "$e" in envelope.payload) {
        continue; // sealed payloads skip the apply (the server's hydration rule)
      }
      store.apply(envelope);
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
}

describe("scripts/lib/scratch-store.ts", () => {
  let dataDir: string;
  let relay: RelayStorage;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-scratch-store-test-"));
    relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    relay.ingest(fixtureEnvelopes());
  });

  afterEach(() => {
    relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("buildScratchStore", () => {
    it("(a) a plaintext workspace replays the tail into a plan-equivalent store", () => {
      const reference = Store.open(betterSqlite3Backend(":memory:"));
      let scratch: Store | null = null;
      try {
        hydrate(relay, reference);
        scratch = buildScratchStore(relay, WORKSPACE);
        expect(planRepeatPropertyMigration(scratch)).toEqual(planRepeatPropertyMigration(reference));
      } finally {
        reference.close();
        scratch?.close();
      }
    });

    it("(b) a SEALED latest snapshot is never restored — no throw, the plaintext tail replays", () => {
      relay.saveSnapshot(
        WORKSPACE,
        "01920000-0000-7000-8000-0000000000e1",
        relay.maxHlc(WORKSPACE),
        relay.latestSeq(WORKSPACE),
        Buffer.from("sealed-garbage-not-a-database"),
        true,
      );
      // A throw fails the test — the sealed blob must never reach restore
      // ("file is not a database").
      const reference = Store.open(betterSqlite3Backend(":memory:"));
      const scratch = buildScratchStore(relay, WORKSPACE);
      try {
        hydrate(relay, reference);
        expect(planRepeatPropertyMigration(scratch)).toEqual(planRepeatPropertyMigration(reference));
      } finally {
        reference.close();
        scratch.close();
      }
    });

    it("(c) an encrypted tail envelope skips the apply; onSkip fires once with the counts", () => {
      relay.ingest([sealedEnvelope()]);
      const onSkip = vi.fn();
      let scratch: Store | null = null;
      try {
        scratch = buildScratchStore(relay, WORKSPACE, onSkip);
        expect(onSkip).toHaveBeenCalledTimes(1);
        expect(onSkip).toHaveBeenCalledWith({ encrypted: 1, pending: 0 });
        // The sealed envelope contributed nothing — the same plan as the
        // plaintext fixture.
        const reference = Store.open(betterSqlite3Backend(":memory:"));
        try {
          hydrate(relay, reference);
          expect(planRepeatPropertyMigration(scratch!)).toEqual(planRepeatPropertyMigration(reference));
        } finally {
          reference.close();
        }
      } finally {
        scratch?.close();
      }

      // No skips → no callback.
      const dataDirPlain = mkdtempSync(join(tmpdir(), "notees-scratch-store-plain-"));
      const relayPlain = new RelayStorage(join(dataDirPlain, "relay.db"), join(dataDirPlain, "snapshots"));
      try {
        relayPlain.ingest(fixtureEnvelopes());
        const silent = vi.fn();
        const store = buildScratchStore(relayPlain, WORKSPACE, silent);
        store.close();
        expect(silent).not.toHaveBeenCalled();
      } finally {
        relayPlain.close();
        rmSync(dataDirPlain, { recursive: true, force: true });
      }
    });
  });

  describe("keyedWorkspaceIds", () => {
    it("returns the keyed ids after a putWorkspaceKey", () => {
      const auth = new AuthStorage(join(dataDir, "relay.db"));
      try {
        auth.putWorkspaceKey(WORKSPACE, "wrapped-key-one");
        auth.putWorkspaceKey(OTHER_WORKSPACE, "wrapped-key-two");
      } finally {
        auth.close();
      }
      expect(keyedWorkspaceIds(dataDir)).toEqual(new Set([WORKSPACE, OTHER_WORKSPACE]));
    });

    it("an empty set when the workspace_key table is absent (a relay-only data dir)", () => {
      // RelayStorage alone never runs the auth DDL — the table is not there.
      expect(keyedWorkspaceIds(dataDir)).toEqual(new Set());
    });

    it("an empty set when relay.db does not exist at all — never a throw", () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "notees-scratch-store-empty-"));
      try {
        expect(keyedWorkspaceIds(emptyDir)).toEqual(new Set());
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe("refuseIfContentOnKeyed", () => {
    it('throws the house refusal for a "content"-class migration against a keyed workspace', () => {
      const auth = new AuthStorage(join(dataDir, "relay.db"));
      try {
        auth.putWorkspaceKey(WORKSPACE, "wrapped-key-one");
      } finally {
        auth.close();
      }
      expect(() =>
        refuseIfContentOnKeyed(dataDir, WORKSPACE, "content", "migrate-example"),
      ).toThrow(
        'migrate-example: "content"-class migration refuses to run server-side against keyed ' +
          `workspace ${WORKSPACE} — sealed content is invisible here; run it through a keyed client`,
      );
    });

    it('is silent for a "scaffolding"-class run against a keyed workspace', () => {
      const auth = new AuthStorage(join(dataDir, "relay.db"));
      try {
        auth.putWorkspaceKey(WORKSPACE, "wrapped-key-one");
      } finally {
        auth.close();
      }
      expect(() =>
        refuseIfContentOnKeyed(dataDir, WORKSPACE, "scaffolding", "migrate-example"),
      ).not.toThrow();
    });

    it('is silent for a "content"-class run against an unkeyed workspace', () => {
      expect(() =>
        refuseIfContentOnKeyed(dataDir, WORKSPACE, "content", "migrate-example"),
      ).not.toThrow();
    });
  });
});
