/**
 * Rail card order — the right rail's device-local stack order (the
 * recents-order precedent): `moveRailCardOrder` is the pure reorder move
 * behind the workspace drag session's report, and read/persist round-trip
 * through the `notees.sidebarCards` localStorage key (validated JSON, the
 * recents read shape).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  moveRailCardOrder,
  persistRailCardOrder,
  readRailCardOrder,
} from "../src/ui/App.js";

const KEY = "notees.sidebarCards";

afterEach(() => {
  localStorage.clear();
});

describe("moveRailCardOrder", () => {
  it("moves the active card before the target", () => {
    expect(moveRailCardOrder(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
  });

  it("moves the active card after the target", () => {
    expect(moveRailCardOrder(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
  });

  it("moves from the middle to the front edge", () => {
    expect(moveRailCardOrder(["a", "b", "c", "d"], "b", "a", "before")).toEqual(["b", "a", "c", "d"]);
  });

  it("drops onto itself return the order unchanged", () => {
    const order = ["a", "b", "c"];
    expect(moveRailCardOrder(order, "b", "b", "after")).toBe(order);
  });

  it("an unknown active or target id returns the order unchanged", () => {
    const order = ["a", "b", "c"];
    expect(moveRailCardOrder(order, "x", "b", "before")).toBe(order);
    expect(moveRailCardOrder(order, "a", "x", "after")).toBe(order);
  });

  it("dropping exactly in place returns the same reference (no render, no write)", () => {
    const order = ["a", "b", "c"];
    // Already directly before/after the target — the genuine no-ops.
    expect(moveRailCardOrder(order, "a", "b", "before")).toBe(order);
    expect(moveRailCardOrder(order, "b", "a", "after")).toBe(order);
    expect(moveRailCardOrder(order, "c", "b", "after")).toBe(order);
    // One past the adjacent edge is a REAL move (sanity: the no-op read
    // above is not just "always returns the input").
    expect(moveRailCardOrder(order, "b", "c", "after")).toEqual(["a", "c", "b"]);
  });
});

describe("the rail card order persistence", () => {
  it("round-trips through localStorage", () => {
    persistRailCardOrder(["a", "b", "c"]);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(["a", "b", "c"]));
    expect(readRailCardOrder()).toEqual(["a", "b", "c"]);
  });

  it("reads an empty list when nothing is stored", () => {
    expect(readRailCardOrder()).toEqual([]);
  });

  it("malformed or mistyped storage reads as empty, never throws", () => {
    localStorage.setItem(KEY, "not json{");
    expect(readRailCardOrder()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ not: "an array" }));
    expect(readRailCardOrder()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(["a", 7, null, "b"]));
    expect(readRailCardOrder()).toEqual(["a", "b"]);
  });
});
