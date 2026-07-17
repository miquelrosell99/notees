import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../src/db";

test("schema creates all required tables", () => {
  const db = new Database(":memory:");
  createSchema(db);
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain("operation");
  expect(names).toContain("node");
  expect(names).toContain("node_child_order");
  expect(names).toContain("property_value");
  expect(names).toContain("edge");
  expect(names).toContain("snapshot");
  expect(names).toContain("compacted_operation_segment");
  expect(names).toContain("crdt_state");
  expect(names).toContain("search_index");
});
