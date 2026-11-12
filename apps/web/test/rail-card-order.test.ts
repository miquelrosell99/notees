/**
 * Rail card order — the right rail's device-local stack order (the
 * recents-order precedent): the order IS the peek recency (most recent
 * first — there is no reorder gesture), and read/persist round-trip through
 * the `notees.sidebarCards` localStorage key (validated JSON, the recents
 * read shape).
 */

import { afterEach, describe, expect, it } from "vitest";

import { persistRailCardOrder, readRailCardOrder } from "../src/ui/app/railCardOrder.js";

const KEY = "notees.sidebarCards";

afterEach(() => {
  localStorage.clear();
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
