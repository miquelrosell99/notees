import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { TextCrdt } from "../../src/crdt/text";
import { applyNodeOperation } from "../../src/derived/node";
import { createOperation } from "../../src/operation";

test("node.updateContent stores plaintext from text crdt", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "block-1", "ws-1", "block", "[]", "[]",
  ]);

  const text = new TextCrdt();
  text.insert(0, "Hello");

  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["block-1"],
      opType: "node.updateContent",
    },
    { nodeId: "block-1", textUpdate: Array.from(text.getState()) }
  );

  applyNodeOperation(db, op);
  const row = db.query("SELECT content FROM node WHERE id = ?").get("block-1") as { content: string };
  expect(JSON.parse(row.content)).toEqual([{ type: "text", text: "Hello" }]);
});
