import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";

test("store creates a page with text content", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  store.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  store.updateText("page-1", (t) => t.insert(0, "Title"));
  const node = store.getNode("page-1");
  expect(node.kind).toBe("page");
  expect(JSON.parse(node.content)[0].text).toBe("Title");
});
