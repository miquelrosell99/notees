/**
 * Store.compact(): VACUUM reclaims replay/delete-derived free pages so a
 * serialized image carries only live content — without touching the data
 * (snapshot → compact → restore round-trips, reads stay honest).
 */

import { beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { Store } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

let sqlModule: SqlJsStatic;
beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

function makeEnvelope(index: number): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "compact-test",
    hlc: { physical: 1_727_200_000_000 + index, logical: 0 },
    opType: "object.create",
    payload: {
      objectId: `0192a000-0000-7000-8000-000000000${String(index).padStart(3, "0")}`,
      contentAst: [{ type: "text", text: `Compact page ${index} ${"x".repeat(512)}` }],
      isEmbedded: false,
    },
    timestamp: "2026-09-24T12:00:00.000Z",
  });
}

describe.each([
  ["better-sqlite3", () => betterSqlite3Backend()],
  ["sql.js", () => sqljsBackend(sqlModule)],
])("Store.compact (%s)", (_name, backend) => {
  it("reclaims free pages: the image shrinks after a bulk delete + compact, data untouched", () => {
    const store = Store.open(backend());
    store.applyMany(Array.from({ length: 200 }, (_, i) => makeEnvelope(i)));
    const beforeDelete = store.snapshot().byteLength;

    // Delete most rows directly (a replay-shaped free-page trail), keep one.
    store.database.exec("DELETE FROM node WHERE content NOT LIKE '%Compact page 0 %'");
    const bloated = store.snapshot().byteLength;
    expect(bloated).toBeGreaterThanOrEqual(beforeDelete);

    store.compact();
    const compacted = store.snapshot().byteLength;
    expect(compacted).toBeLessThan(bloated);

    // The survivor reads honestly after the vacuum.
    const survivor = store.getNode("0192a000-0000-7000-8000-000000000000");
    expect(survivor).toBeDefined();
    expect(JSON.parse(survivor!.content)[0].text).toContain("Compact page 0");

    // And the compacted image restores cleanly.
    const restored = Store.open(backend());
    restored.restore(store.snapshot());
    expect(restored.getNode("0192a000-0000-7000-8000-000000000000")).toBeDefined();
    store.close();
    restored.close();
  });
});
