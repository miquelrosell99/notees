import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { rebuildEdgesForNode } from "../../src/derived/edge";

test("rebuildEdgesForNode creates edges from content refs", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1",
    "ws-1",
    "page",
    "[]",
    JSON.stringify([{ type: "ref", targetId: "node-2", label: "Two" }]),
  ]);

  rebuildEdgesForNode(db, "node-1");
  const rows = db
    .query("SELECT target_id FROM edge WHERE source_id = ?")
    .all("node-1") as { target_id: string }[];
  expect(rows.map((r) => r.target_id)).toContain("node-2");
});
