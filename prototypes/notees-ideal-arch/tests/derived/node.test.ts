import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { applyNodeOperation } from "../../src/derived/node";
import { createOperation } from "../../src/operation";

test("node.create inserts a node row", () => {
  const db = new Database(":memory:");
  createSchema(db);
  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "node.create",
    },
    { nodeId: "node-1", kind: "page", parentId: null, classIds: [] }
  );
  applyNodeOperation(db, op);
  const row = db.query("SELECT kind FROM node WHERE id = ?").get("node-1") as { kind: string };
  expect(row.kind).toBe("page");
});
