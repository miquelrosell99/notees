/**
 * useRailCards — the right rail's card stack semantics:
 * - a node renders as a SINGLE card instance; re-peeking a carded node
 *   moves it to the top (most recent first), never duplicates,
 * - open brings the panel; close / close others / close all, and closing
 *   the last card closes the panel with it,
 * - the collapse stack: toggle, collapse others/all, expand all — and
 *   closed cards are pruned from the collapsed set,
 * - the order persists device-locally on every change (the recents seam).
 */

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { AnyClient } from "../src/ui/app/clients.js";
import { useRailCards } from "../src/ui/app/useRailCards.js";

const KEY = "notees.sidebarCards";

afterEach(() => {
  localStorage.clear();
});

function setup() {
  const setRightPanelOpen = vi.fn();
  const clientRef = createRef<AnyClient | null>();
  const { result } = renderHook(() =>
    useRailCards({ client: null, clientRef, setRightPanelOpen }),
  );
  return { result, setRightPanelOpen };
}

describe("useRailCards", () => {
  it("re-peeking a carded node moves it to the top — a single instance, never a duplicate", () => {
    const { result } = setup();
    act(() => {
      result.current.openInSidebar("a");
      result.current.openInSidebar("b");
      result.current.openInSidebar("c");
    });
    expect(result.current.sidebarCards).toEqual(["c", "b", "a"]);

    act(() => result.current.openInSidebar("b"));
    expect(result.current.sidebarCards).toEqual(["b", "c", "a"]);
  });

  it("opening a card opens the panel", () => {
    const { result, setRightPanelOpen } = setup();
    act(() => result.current.openInSidebar("a"));
    expect(setRightPanelOpen).toHaveBeenCalledWith(true);
  });

  it("close removes the card; closing the last card closes the panel", () => {
    const { result, setRightPanelOpen } = setup();
    act(() => {
      result.current.openInSidebar("a");
      result.current.openInSidebar("b");
    });
    act(() => result.current.closeSidebarCard("b"));
    expect(result.current.sidebarCards).toEqual(["a"]);
    expect(setRightPanelOpen).not.toHaveBeenCalledWith(false);

    act(() => result.current.closeSidebarCard("a"));
    expect(result.current.sidebarCards).toEqual([]);
    expect(setRightPanelOpen).toHaveBeenCalledWith(false);
  });

  it("close others keeps only the given card; close all empties the rail and closes the panel", () => {
    const { result, setRightPanelOpen } = setup();
    act(() => {
      result.current.openInSidebar("a");
      result.current.openInSidebar("b");
      result.current.openInSidebar("c");
    });
    act(() => result.current.closeOtherSidebarCards("b"));
    expect(result.current.sidebarCards).toEqual(["b"]);

    act(() => result.current.closeAllSidebarCards());
    expect(result.current.sidebarCards).toEqual([]);
    expect(setRightPanelOpen).toHaveBeenCalledWith(false);
  });

  it("the collapse stack toggles, scopes across cards, and prunes closed cards", () => {
    const { result } = setup();
    act(() => {
      result.current.openInSidebar("a");
      result.current.openInSidebar("b");
      result.current.openInSidebar("c");
    });

    act(() => result.current.toggleSidebarCardCollapsed("a"));
    expect(result.current.collapsedCards.has("a")).toBe(true);
    act(() => result.current.toggleSidebarCardCollapsed("a"));
    expect(result.current.collapsedCards.has("a")).toBe(false);

    act(() => {
      result.current.toggleSidebarCardCollapsed("b");
      result.current.collapseOtherSidebarCards("b");
    });
    expect(result.current.collapsedCards.has("b")).toBe(true);
    expect(result.current.collapsedCards.size).toBe(1);

    act(() => result.current.collapseAllSidebarCards());
    expect(result.current.collapsedCards.size).toBe(3);
    act(() => result.current.expandAllSidebarCards());
    expect(result.current.collapsedCards.size).toBe(0);

    // Closing a card prunes it from the collapsed set.
    act(() => {
      result.current.collapseAllSidebarCards();
      result.current.closeSidebarCard("b");
    });
    expect(result.current.collapsedCards.has("b")).toBe(false);
    expect(result.current.collapsedCards.size).toBe(2);
  });

  it("persists the recency order device-locally on every change", () => {
    const { result } = setup();
    act(() => {
      result.current.openInSidebar("a");
      result.current.openInSidebar("b");
    });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual(["b", "a"]);
    act(() => result.current.closeSidebarCard("b"));
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual(["a"]);
  });
});
