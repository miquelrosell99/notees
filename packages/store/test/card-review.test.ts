/**
 * Memorization-card reviews (SCHEMA.md "Memorization cards"): the
 * `card.review` op lands as HISTORY-ONLY rows in the derived `card_review`
 * table — append-only, NO LWW gate, NO superseded path, and it never writes
 * property values (the seeded card-family properties stay the current
 * schedule surface; the op is the review journal).
 *
 *  - one envelope -> one row, listed back through store.listCardReviews
 *    with JSON-parsed state snapshots;
 *  - concurrent reviews from different actors are BOTH history — every
 *    graded review lists back;
 *  - fail loud: the target node must exist and carry the card system class
 *    (MoveGuardError / NotFoundError, the write-time-impossible law);
 *  - v34 -> v35 migration: an old-version database gains the table.
 *
 * Runs against BOTH shipped adapters, like the main store suite (the
 * migration arm is better-sqlite3-only — it needs a raw file handle).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { MoveGuardError, NotFoundError, Store, type StoreBackend } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";
import { schemaSql } from "../src/schema.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const ACTOR_B = "0192a000-0000-7000-8000-000000000003";

// The card system class (seeds.ts SYSTEM_CLASS_UUIDS.card — a system seed,
// so no class.create is needed to class a node with it).
const CARD_CLASS = "00000000-0000-0000-0001-000000000011";

const CARD_NODE = "0192a000-0000-7000-8000-000000000c40";
const PLAIN_NODE = "0192a000-0000-7000-8000-000000000c41";
const MISSING_NODE = "0192a000-0000-7000-8000-000000000c42";
const SESSION_A = "0192a000-0000-7000-8000-000000000c44";
const SESSION_B = "0192a000-0000-7000-8000-000000000c45";

type SrsState = {
  due: string | null;
  reps: number;
  interval: number;
  ease: number | null;
  difficulty: number | null;
  stability: number | null;
};

const UNSEEN: SrsState = {
  due: null,
  reps: 0,
  interval: 0,
  ease: null,
  difficulty: null,
  stability: null,
};

const SEEN: SrsState = {
  due: "2026-10-28",
  reps: 1,
  interval: 1,
  ease: 2.5,
  difficulty: null,
  stability: null,
};

function reviewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cardId: CARD_NODE,
    grade: "good",
    algorithm: "sm2",
    stateBefore: UNSEEN,
    stateAfter: SEEN,
    reviewedAt: "2026-10-28T09:05:00.000Z",
    sessionId: SESSION_A,
    ...overrides,
  };
}

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
  logical = 0,
  actor = ACTOR,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: actor,
    deviceId: "test-device-card-review",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
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
      const dir = mkdtempSync(join(tmpdir(), "notees-card-review-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

describe.each(adapters)("$name", ({ makeBackend }) => {
  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  /** The card-classed node plus an unclassed control node. */
  function seededStore(): Store {
    const store = makeStore();
    store.apply(
      env(
        "object.create",
        {
          objectId: CARD_NODE,
          classIds: [CARD_CLASS],
          contentAst: [{ type: "text", text: "Spanish vocab: perro" }],
        },
        1727200000000,
      ),
    );
    store.apply(
      env(
        "object.create",
        { objectId: PLAIN_NODE, contentAst: [{ type: "text", text: "Just a page" }] },
        1727200000100,
      ),
    );
    return store;
  }

  it("applies a card.review envelope and lists it back", () => {
    const store = seededStore();
    store.apply(env("card.review", reviewPayload(), 1727200001000));

    const rows = store.listCardReviews(CARD_NODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      sessionId: SESSION_A,
      grade: "good",
      algorithm: "sm2",
      stateBefore: UNSEEN,
      stateAfter: SEEN,
      reviewedAt: "2026-10-28T09:05:00.000Z",
    });
  });

  it("applies two concurrent reviews from different actors", () => {
    const store = seededStore();
    store.apply(env("card.review", reviewPayload(), 1727200001000, 0, ACTOR));
    store.apply(
      env(
        "card.review",
        reviewPayload({ grade: "again", stateBefore: SEEN, sessionId: SESSION_B }),
        1727200002000,
        0,
        ACTOR_B,
      ),
    );

    // History is append-only: BOTH graded reviews list back, HLC-ordered —
    // no LWW collapse, no throw.
    const rows = store.listCardReviews(CARD_NODE);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sessionId)).toEqual([SESSION_A, SESSION_B]);
    expect(rows[1]!.grade).toBe("again");
  });

  it("fails loud when the target node is not classed card", () => {
    const store = seededStore();
    expect(() =>
      store.apply(env("card.review", reviewPayload({ cardId: PLAIN_NODE }), 1727200001000)),
    ).toThrow(MoveGuardError);
    expect(() =>
      store.apply(env("card.review", reviewPayload({ cardId: PLAIN_NODE }), 1727200001000)),
    ).toThrow(/card\.review/);
    expect(store.listCardReviews(PLAIN_NODE)).toHaveLength(0);
  });

  it("fails loud when the cardId does not exist", () => {
    const store = seededStore();
    expect(() =>
      store.apply(env("card.review", reviewPayload({ cardId: MISSING_NODE }), 1727200001000)),
    ).toThrow(NotFoundError);
    expect(store.listCardReviews(MISSING_NODE)).toHaveLength(0);
  });
});

describe("v34 -> v35 migration (better-sqlite3)", () => {
  it("creates the card_review table on an old-version database", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-card-review-migrate-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "store.db");

    // A database at the pre-card schema: the v34 shape, no card_review
    // table, user_version pinned to 34.
    const raw = new Database(dbPath);
    raw.exec(schemaSql());
    raw.exec("DROP TABLE IF EXISTS card_review;");
    raw.pragma("user_version = 34");
    raw.close();

    const store = Store.openFile(dbPath);
    const table = store.database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_review'")
      .get();
    expect(table).toBeDefined();
    expect(store.database.pragma("user_version", { simple: true })).toBe(35);
  });
});
