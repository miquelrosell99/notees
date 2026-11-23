/**
 * childQuery — the body's item-resolution factory.
 * Page mode: children as siblings. Block mode: the node as the single root
 * item. Comment-classed rows are cut at EVERY level, with their subtrees —
 * they surface only in the Comments section, never the main body.
 */

import { describe, expect, it } from "vitest";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { childQuery } from "../src/features/collection/childQuery.js";

interface FakeNode {
  id: string;
  classIds: string[];
}

function node(id: string, classIds: string[] = []): FakeNode {
  return { id, classIds };
}

/** The fake tree entry shape (explicit — a ReturnType self-reference is circular). */
interface Entry {
  node: FakeNode;
  children: Entry[];
}

function entry(n: FakeNode, children: Entry[] = []): Entry {
  return { node: n, children };
}

const comment = () => node("c1", [SYSTEM_CLASS_UUIDS.comment]);

function fakeClient(root: FakeNode, tree: Entry[]) {
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
    expect(items[1]!.children?.map((i) => i.node.id)).toEqual(["b1"]);
  });

  it("block mode (showRoot): the node itself as the single root item", () => {
    const tree = [entry(node("a"))];
    const items = childQuery(fakeClient(node("root"), tree), "root", { showRoot: true });
    expect(items).toHaveLength(1);
    expect(items[0]!.node.id).toBe("root");
    expect(items[0]!.children?.map((i) => i.node.id)).toEqual(["a"]);
  });

  it("comment-classed children are cut at every level, subtrees included", () => {
    const tree = [
      entry(node("a")),
      entry(comment(), [entry(node("c-reply"))]),
      entry(node("b"), [entry(comment()), entry(node("b1"))]),
    ];
    const items = childQuery(fakeClient(node("root"), tree), "root");
    expect(items.map((i) => i.node.id)).toEqual(["a", "b"]);
    expect(items[1]!.children?.map((i) => i.node.id)).toEqual(["b1"]);
  });

  it("block mode: a comment root still renders (only its comment children are cut)", () => {
    const items = childQuery(fakeClient(comment(), []), "c1", { showRoot: true });
    expect(items).toHaveLength(1);
    expect(items[0]!.node.id).toBe("c1");
  });
});

describe("childQuery structural sharing (the per-keystroke bail-out contract)", () => {
  /** A fake whose getBlockTree returns FRESH wrapper objects per call — the
   *  re-serve shape — with node identities stable across calls (the worker's
   *  per-row map cache contract). */
  function reseedingClient(root: FakeNode, nodes: FakeNode[]) {
    const treeOf = (): Entry[] => nodes.filter((n) => n !== root).map((n) => ({ node: n, children: [] }));
    return {
      getBlockTree: () => treeOf(),
      getNode: (id: string) => (id === root.id ? root : nodes.find((n) => n.id === id)),
    } as never;
  }

  it("a re-serve with stable node identities returns the SAME item array", () => {
    const root = node("root");
    const a = node("a");
    const b = node("b");
    const client = reseedingClient(root, [a, b]);
    const first = childQuery(client, "root");
    const second = childQuery(client, "root");
    // Fresh tree wrappers per call, identical nodes: the items must be
    // reference-stable (the BlockRow memo's O(1) fast-path depends on it).
    expect(second).toBe(first);
    expect(first.map((i) => i.node.id)).toEqual(["a", "b"]);
  });

  it("a changed node rebuilds its own item only — siblings keep their identity", () => {
    const root = node("root");
    const a = node("a");
    const b = node("b");
    // The re-serve replaces `a` with a NEW node object (the edited row);
    // `b` keeps its identity.
    const client = (() => {
      let currentA = a;
      const treeOf = (): Entry[] => [
        { node: currentA, children: [] },
        { node: b, children: [] },
      ];
      return {
        getBlockTree: () => treeOf(),
        getNode: (id: string) =>
          id === "root" ? root : id === "a" ? currentA : b,
        /** Test-only: swap the edited row's node object. */
        __edit: () => {
          currentA = node("a");
        },
      } as never;
    })();
    const first = childQuery(client, "root");
    (client as unknown as { __edit(): void }).__edit();
    const second = childQuery(client, "root");
    expect(second).not.toBe(first);
    expect(second[0]!.node).not.toBe(first[0]!.node);
    expect(second[1]).toBe(first[1]);
  });
});
