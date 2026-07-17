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

test("rebuildEdgesForNode preserves edge ids for unchanged references", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1",
    "ws-1",
    "page",
    "[]",
    JSON.stringify([
      { type: "ref", targetId: "node-2", label: "Two" },
      { type: "ref", targetId: "node-3", label: "Three" },
    ]),
  ]);

  rebuildEdgesForNode(db, "node-1");
  const first = db
    .query("SELECT id, target_id, metadata FROM edge WHERE source_id = ? ORDER BY target_id")
    .all("node-1") as { id: string; target_id: string; metadata: string }[];

  db.run(
    "UPDATE node SET content = ? WHERE id = ?",
    [
      JSON.stringify([
        { type: "ref", targetId: "node-2", label: "Two" },
        { type: "ref", targetId: "node-4", label: "Four" },
      ]),
      "node-1",
    ]
  );
  rebuildEdgesForNode(db, "node-1");
  const second = db
    .query("SELECT id, target_id, metadata FROM edge WHERE source_id = ? ORDER BY target_id")
    .all("node-1") as { id: string; target_id: string; metadata: string }[];

  const kept = second.find((r) => r.target_id === "node-2");
  const original = first.find((r) => r.target_id === "node-2");
  expect(kept).toBeDefined();
  expect(original).toBeDefined();
  expect(kept!.id).toBe(original!.id);
  expect(kept!.metadata).toBe(original!.metadata);
  expect(second.some((r) => r.target_id === "node-3")).toBeFalse();
  expect(second.some((r) => r.target_id === "node-4")).toBeTrue();
});

test("rebuildEdgesForNode updates metadata when a label changes", () => {
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
  const first = db
    .query("SELECT id, metadata FROM edge WHERE source_id = ? AND target_id = ?")
    .get("node-1", "node-2") as { id: string; metadata: string };

  db.run(
    "UPDATE node SET content = ? WHERE id = ?",
    [JSON.stringify([{ type: "ref", targetId: "node-2", label: "Deux" }]), "node-1"]
  );
  rebuildEdgesForNode(db, "node-1");
  const second = db
    .query("SELECT id, metadata FROM edge WHERE source_id = ? AND target_id = ?")
    .get("node-1", "node-2") as { id: string; metadata: string };

  expect(second.id).toBe(first.id);
  expect(second.metadata).toBe(JSON.stringify({ label: "Deux" }));
});
