/**
 * nestItems specs — the display-time nesting helper (the Pages hub's
 * all-pages ruling): a flat item set becomes a tree purely from
 * `node.parentId` membership — an item whose parent is not in the set
 * (parentless, or parent filtered out) stays top-level; children attach
 * to their in-set parent in input order. Cycles fail soft (the walker
 * treats a revisiting chain as top-level) — structural cycles are
 * write-time impossible, so this is defense only.
 */

import { describe, expect, it } from "vitest";

import type { ClientNode } from "../src/core/workspace-client/index.js";
import { nestItems } from "../src/features/collection/nestItems.js";
import type { NodeCollectionItem } from "../src/features/collection/types.js";

/** Minimal node stand-in — nestItems reads only id + parentId. */
function node(id: string, parentId: string | null = null): ClientNode {
  return { id, parentId } as unknown as ClientNode;
}

function item(id: string, parentId: string | null = null): NodeCollectionItem {
  return { node: node(id, parentId) };
}

/** The ids of one nesting level, in order. */
function levelIds(items: NodeCollectionItem[]): string[] {
  return items.map((entry) => entry.node.id);
}

describe("nestItems", () => {
  it("attaches children to their in-set parent, input order kept", () => {
    const nested = nestItems([
      item("parent"),
      item("child-b", "parent"),
      item("other"),
      item("child-a", "parent"),
    ]);
    expect(levelIds(nested)).toEqual(["parent", "other"]);
    const parent = nested[0]!;
    expect(parent.children).not.toBeUndefined();
    expect(levelIds(parent.children!)).toEqual(["child-b", "child-a"]);
    // The childless level stays childless.
    expect(nested[1]!.children).toBeUndefined();
  });

  it("nests grandchildren through the chain", () => {
    const nested = nestItems([item("root"), item("mid", "root"), item("leaf", "mid")]);
    expect(levelIds(nested)).toEqual(["root"]);
    const mid = nested[0]!.children![0]!;
    expect(mid.node.id).toBe("mid");
    expect(levelIds(mid.children!)).toEqual(["leaf"]);
  });

  it("an item whose parent is not in the set stays top-level", () => {
    const nested = nestItems([item("orphan", "absent-parent"), item("root")]);
    expect(levelIds(nested)).toEqual(["orphan", "root"]);
    expect(nested[0]!.children).toBeUndefined();
  });

  it("nests a child that precedes its parent in the input", () => {
    const nested = nestItems([item("child", "root"), item("root")]);
    expect(levelIds(nested)).toEqual(["root"]);
    expect(levelIds(nested[0]!.children!)).toEqual(["child"]);
  });

  it("a parent cycle fails soft — the cycle's walker stays top-level", () => {
    // a → b → a: impossible state (write-time guarded), but the helper
    // must not hang or drop rows.
    const nested = nestItems([item("a", "b"), item("b", "a"), item("standalone")]);
    expect(levelIds(nested)).toEqual(["a", "b", "standalone"]);
  });

  it("does not mutate the input items", () => {
    const input = [item("parent"), item("child", "parent")];
    nestItems(input);
    expect(input[0]!.children).toBeUndefined();
    expect(input[1]!.children).toBeUndefined();
  });
});
