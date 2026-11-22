/**
 * Node attribution projections (the `created_*`/`updated_*` columns): every
 * envelope already carries actorId + timestamp + HLC, so the node row's
 * attribution is a pure derived projection — no wire change.
 *
 * Semantics pinned here:
 *  - object.create / class.create stamp created_* AND updated_* from the
 *    envelope (created = first writer in apply order wins by INSERT, the
 *    row either appears now or already existed).
 *  - object.update / object.move move updated_* on every accepted write; a
 *    LWW-IGNORED update leaves attribution untouched.
 *  - object.delete (soft) stamps updated_* on the WHOLE trashed subtree (the
 *    row's liveness flipped); object.restore stamps the reactivated set the
 *    same way; created_* never move.
 *  - class.create on an existing node (the conversion arm) bumps updated_*
 *    but keeps the original created_* (the node WAS created earlier).
 *  - class.reorder (a direct user gesture on the node's own class_order
 *    field) bumps updated_*.
 *  - Membership recomputes (class.assign / tag add) deliberately do NOT bump
 *    updated_* (the mappers.ts nodeRowStamp rationale) — class_ids/tag_ids
 *    are OR-Set projections, not node edits. Same for property values (they
 *    carry their own per-value history with actors).
 *
 * Runs against BOTH shipped adapters, like the focused suites.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { Store, type StoreBackend } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR_LAPTOP = "0192a000-0000-7000-8000-000000000002";
const ACTOR_PHONE = "0192a000-0000-7000-8000-000000000003";

const NODE_PAGE = "0192a000-0000-7000-8000-000000000010";
const NODE_CHILD = "0192a000-0000-7000-8000-000000000011";
const NODE_OTHER = "0192a000-0000-7000-8000-000000000012";
const USER_CLASS = "0192a000-0000-7000-8000-0000000000c1";
const TAG_A = "0192a000-0000-7000-8000-0000000000a1";

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
  logical = 0,
  actor = ACTOR_LAPTOP,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: actor,
    deviceId: "test-device-attribution",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

function iso(physical: number): string {
  return new Date(physical).toISOString();
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
      const dir = mkdtempSync(join(tmpdir(), "notees-attribution-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

for (const adapter of adapters) {
  describe(`node attribution on ${adapter.name}`, () => {
    it("object.create stamps created_* and updated_* from the envelope", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("object.create", { objectId: NODE_PAGE }, 1727200001000));
      const row = store.getNode(NODE_PAGE);
      expect(row?.created_by).toBe(ACTOR_LAPTOP);
      expect(row?.created_at).toBe(iso(1727200001000));
      expect(row?.updated_by).toBe(ACTOR_LAPTOP);
      expect(row?.updated_at).toBe(iso(1727200001000));
    });

    it("class.create stamps attribution on the class node row", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(
        env(
          "class.create",
          { classId: USER_CLASS, contentAst: [{ type: "text", text: "Genre" }] },
          1727200002000,
          0,
          ACTOR_PHONE,
        ),
      );
      const row = store.getNode(USER_CLASS);
      expect(row?.is_class).toBe(1);
      expect(row?.created_by).toBe(ACTOR_PHONE);
      expect(row?.created_at).toBe(iso(1727200002000));
      expect(row?.updated_by).toBe(ACTOR_PHONE);
    });

    it("object.update moves updated_*; created_* stay; a LWW-ignored update touches nothing", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("object.create", { objectId: NODE_PAGE }, 1727200001000));
      store.apply(
        env("object.update", { objectId: NODE_PAGE, color: "sky" }, 1727200003000, 0, ACTOR_PHONE),
      );
      let row = store.getNode(NODE_PAGE);
      expect(row?.updated_by).toBe(ACTOR_PHONE);
      expect(row?.updated_at).toBe(iso(1727200003000));
      expect(row?.created_by).toBe(ACTOR_LAPTOP);
      expect(row?.created_at).toBe(iso(1727200001000));

      // A STALE update (lower HLC than the accepted color write) is ignored:
      // attribution stays with the winning op.
      const ignored = store.apply(
        env("object.update", { objectId: NODE_PAGE, icon: "x" }, 1727200001500, 0, ACTOR_LAPTOP),
      );
      expect(ignored.ignored).toBe(true);
      row = store.getNode(NODE_PAGE);
      expect(row?.updated_by).toBe(ACTOR_PHONE);
      expect(row?.updated_at).toBe(iso(1727200003000));
      expect(row?.icon).toBeNull();
    });

    it("object.move bumps updated_* with the mover's identity", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("object.create", { objectId: NODE_PAGE }, 1727200001000));
      store.apply(
        env("object.create", { objectId: NODE_CHILD, parentId: NODE_PAGE }, 1727200002000),
      );
      store.apply(
        env(
          "object.move",
          { objectId: NODE_CHILD, parentId: null },
          1727200004000,
          0,
          ACTOR_PHONE,
        ),
      );
      const row = store.getNode(NODE_CHILD);
      expect(row?.parent_id).toBeNull();
      expect(row?.updated_by).toBe(ACTOR_PHONE);
      expect(row?.updated_at).toBe(iso(1727200004000));
      expect(row?.created_by).toBe(ACTOR_LAPTOP);
    });

    it("soft delete stamps updated_* on the whole trashed subtree; restore stamps the reactivated set", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("object.create", { objectId: NODE_PAGE }, 1727200001000));
      store.apply(
        env("object.create", { objectId: NODE_CHILD, parentId: NODE_PAGE }, 1727200002000),
      );
      store.apply(
        env("object.delete", { objectId: NODE_PAGE }, 1727200005000, 0, ACTOR_PHONE),
      );
      let row = store.getNode(NODE_PAGE);
      const child = store.getNode(NODE_CHILD);
      expect(row?.is_active).toBe(0);
      expect(row?.updated_by).toBe(ACTOR_PHONE);
      expect(row?.updated_at).toBe(iso(1727200005000));
      expect(child?.is_active).toBe(0);
      expect(child?.updated_by).toBe(ACTOR_PHONE);
      expect(child?.updated_at).toBe(iso(1727200005000));
      // created_* never move:
      expect(row?.created_by).toBe(ACTOR_LAPTOP);
      expect(child?.created_by).toBe(ACTOR_LAPTOP);

      store.apply(
        env("object.restore", { objectId: NODE_PAGE }, 1727200006000, 0, ACTOR_LAPTOP),
      );
      row = store.getNode(NODE_PAGE);
      expect(row?.is_active).toBe(1);
      expect(row?.updated_by).toBe(ACTOR_LAPTOP);
      expect(row?.updated_at).toBe(iso(1727200006000));
      expect(store.getNode(NODE_CHILD)?.is_active).toBe(1);
    });

    it("class conversion bumps updated_* but keeps the original created_*", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("object.create", { objectId: NODE_OTHER }, 1727200001000));
      store.apply(
        env(
          "class.create",
          { classId: NODE_OTHER, contentAst: [{ type: "text", text: "Genre" }] },
          1727200007000,
          0,
          ACTOR_PHONE,
        ),
      );
      const row = store.getNode(NODE_OTHER);
      expect(row?.is_class).toBe(1);
      expect(row?.created_by).toBe(ACTOR_LAPTOP);
      expect(row?.created_at).toBe(iso(1727200001000));
      expect(row?.updated_by).toBe(ACTOR_PHONE);
      expect(row?.updated_at).toBe(iso(1727200007000));
    });

    it("class.reorder bumps updated_*", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("object.create", { objectId: NODE_PAGE }, 1727200001000));
      store.apply(env("class.create", { classId: USER_CLASS }, 1727200002000));
      // Class adds ride the object.create re-issue carrier, like tags.
      store.apply(
        env("object.create", { objectId: NODE_PAGE, classIds: [USER_CLASS] }, 1727200003000),
      );
      store.apply(
        env("class.reorder", { objectId: NODE_PAGE, classIds: [USER_CLASS] }, 1727200008000, 0, ACTOR_PHONE),
      );
      const row = store.getNode(NODE_PAGE);
      expect(row?.updated_by).toBe(ACTOR_PHONE);
      expect(row?.updated_at).toBe(iso(1727200008000));
    });

    it("membership recomputes (class.assign, tag add) deliberately do NOT bump updated_*", () => {
      const store = Store.open(adapter.makeBackend());
      store.apply(env("object.create", { objectId: NODE_PAGE }, 1727200001000));
      store.apply(env("class.create", { classId: USER_CLASS }, 1727200002000));
      store.apply(
        env("object.create", { objectId: NODE_PAGE, classIds: [USER_CLASS] }, 1727200009000, 0, ACTOR_PHONE),
      );
      let row = store.getNode(NODE_PAGE);
      expect(row?.class_ids).toBe(JSON.stringify([USER_CLASS]));
      expect(row?.updated_by).toBe(ACTOR_LAPTOP);
      expect(row?.updated_at).toBe(iso(1727200001000));

      // Tag adds ride the object.create re-issue carrier (add-wins OR-Set):
      // it never touches the node row, so attribution stays put.
      store.apply(
        env("object.create", { objectId: NODE_PAGE, tagIds: [TAG_A] }, 1727200010000, 0, ACTOR_PHONE),
      );
      row = store.getNode(NODE_PAGE);
      expect(row?.tag_ids).toBe(JSON.stringify([TAG_A]));
      expect(row?.updated_by).toBe(ACTOR_LAPTOP);
      expect(row?.updated_at).toBe(iso(1727200001000));
    });
  });
}
