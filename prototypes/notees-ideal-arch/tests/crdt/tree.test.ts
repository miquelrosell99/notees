import { expect, test } from "bun:test";
import { TreeCrdt, treeOperationPayload } from "../../src/crdt/tree";

test("tree crdt converges concurrent inserts", () => {
  const t1 = new TreeCrdt();
  t1.insert("a", 0);

  const t2 = new TreeCrdt();
  t2.applyUpdate(t1.getState());
  t2.insert("b", 0);

  t1.applyUpdate(t2.getState());
  expect(t1.toArray()).toContain("a");
  expect(t1.toArray()).toContain("b");
  expect(t1.toArray().length).toBe(2);
});

test("treeOperationPayload returns parentId and update", () => {
  const update = new Uint8Array([1, 2, 3]);
  const payload = treeOperationPayload("parent-1", update);
  expect(payload).toEqual({ parentId: "parent-1", update });
});
