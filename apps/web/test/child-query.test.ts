/**
 * childQuery (S4/M1+M19) — the body's item-resolution factory.
 * Page mode: children as siblings. Block mode: the node as the single root
 * item. Comment-classed rows are cut at EVERY level, with their subtrees —
 * they surface only in the Comments section (M19), never the main body.
 */

import { describe, expect, it } from "vitest";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { childQuery } from "../src/ui/components/childQuery.js";

interface FakeNode {
  id: string;
  classIds: string[];
}

function node(id: string, classIds: string[] = []): FakeNode {
  return { id, classIds };
}

function entry(n: FakeNode, children: ReturnType<typeof entry>[] = []) {
  return { node: n, children };
}

const comment = () => node("c1", [SYSTEM_CLASS_UUIDS.comment]);

function fakeClient(root: FakeNode, tree: ReturnType<typeof entry>[]) {
  return {
    getBlockTree: () => tree,
    getNode: (id: string) => (id === root.id ? root : undefined),
  } as never;
}

describe("childQuery", () => {
  it("page mode: children as top-level items", () => {
    const tree = [entry(node("a")), entry(node("b"), [entry(node("b1"))])];
    const items = childQuery(fakeClient(node("root"), tree), "root");
    expect(items.map((i) => i.node.id)).toEqual(["a", "b"]);
    expect(items[1].children?.map((i) => i.node.id)).toEqual(["b1"]);
  });

  it("block mode (showRoot): the node itself as the single root item", () => {
    const tree = [entry(node("a"))];
    const items = childQuery(fakeClient(node("root"), tree), "root", { showRoot: true });
    expect(items).toHaveLength(1);
    expect(items[0].node.id).toBe("root");
    expect(items[0].children?.map((i) => i.node.id)).toEqual(["a"]);
  });

  it("comment-classed children are cut at every level, subtrees included", () => {
    const tree = [
      entry(node("a")),
      entry(comment(), [entry(node("c-reply"))]),
      entry(node("b"), [entry(comment()), entry(node("b1"))]),
    ];
    const items = childQuery(fakeClient(node("root"), tree), "root");
    expect(items.map((i) => i.node.id)).toEqual(["a", "b"]);
    expect(items[1].children?.map((i) => i.node.id)).toEqual(["b1"]);
  });

  it("block mode: a comment root still renders (only its comment children are cut)", () => {
    const items = childQuery(fakeClient(comment(), []), "c1", { showRoot: true });
    expect(items).toHaveLength(1);
    expect(items[0].node.id).toBe("c1");
  });
});
