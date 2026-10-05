/**
 * Remote-history quarantine (store schema v9): an op that fails to apply
 * inside a remote batch is quarantined — recorded, marked processed so the
 * cursor advances, and surfaced in the summary — so one poison op in the
 * log (e.g. the pre-Revision-11 class-parenting move, seq 52497 on the live
 * workspace) never bricks every fresh replay. Local authoring (Store.apply)
 * stays fail-loud. Both adapters.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";

import type { StoreBackend } from "../src/db.js";
import { Store } from "../src/store.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const NODE_PAGE = "0192a000-0000-7000-8000-000000000010";
const NODE_BLOCK = "0192a000-0000-7000-8000-000000000020";
const NODE_CLASS = "0192a000-0000-7000-8000-000000000030";
const NODE_PARENT = "0192a000-0000-7000-8000-000000000040";

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
  logical = 0,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-quarantine",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  } as Parameters<typeof newEnvelope>[0]);
}

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const adapters: { name: string; makeBackend: () => StoreBackend }[] = [
  { name: "sqljs", makeBackend: () => sqljsBackend(sqlModule) },
  {
    name: "better-sqlite3",
    makeBackend: () => {
      const dir = mkdtempSync(join(tmpdir(), "notees-quarantine-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

describe.each(adapters)("$name", ({ makeBackend }) => {
  it("quarantines a poison op inside a remote batch and keeps converging", () => {
    const store = Store.open(makeBackend());
    const goodA = env("object.create", { objectId: NODE_PARENT, classIds: [] }, 1727200000000);
    // The live-log poison shape: a class-parenting move (pre-Revision-11).
    const poison = env(
      "object.move",
      { objectId: NODE_CLASS, parentId: NODE_PARENT },
      1727200000100,
    );
    const goodB = env(
      "object.create",
      { objectId: NODE_BLOCK, parentId: NODE_PARENT },
      1727200000200,
    );

    store.applyMany(
      [
        env("class.create", { classId: NODE_CLASS, contentAst: [{ type: "text", text: "c" }] }, 1727199999900),
        goodA,
        poison,
        goodB,
      ],
      { quarantineMoveGuards: true },
    );

    // Both good ops landed; the poison is quarantined, not applied.
    expect(store.getNode(NODE_BLOCK)).not.toBeUndefined();
    expect(store.getNode(NODE_CLASS)?.parent_id ?? null).toBeNull();

    const quarantined = store.quarantinedEnvelopes();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      id: poison.id,
      opType: "object.move",
    });
    expect(quarantined[0]!.error).toContain("cannot have a parent");

    // Re-applying the batch is a no-op (the quarantined id is processed).
    const again = store.applyMany([poison, goodB]);
    expect(again.every((s) => s.ignored)).toBe(true);
    expect(store.quarantinedEnvelopes()).toHaveLength(1);
  });

  it("local apply() of a poison op still throws (fail-loud law)", () => {
    const store = Store.open(makeBackend());
    store.apply(
      env("class.create", { classId: NODE_CLASS, contentAst: [{ type: "text", text: "c" }] }, 1727199999900),
    );
    store.apply(env("object.create", { objectId: NODE_PARENT, classIds: [] }, 1727200000000));
    expect(() =>
      store.apply(
        env("object.move", { objectId: NODE_CLASS, parentId: NODE_PARENT }, 1727200000100),
      ),
    ).toThrow(/cannot have a parent/);
    expect(store.quarantinedEnvelopes()).toHaveLength(0);
  });
});
