/**
 * The top bar's Back/Forward arrows (owner 2026-10-14): window.history
 * back/forward through the App's OWN navigation stack — the tracked stack
 * (recordNavPush/recordNavPop) exists because the browser stack reaches
 * beyond the app, so the arrows' disabled states ride our cursor, never the
 * browser's. The popstate handler reports every landing to the tracker via
 * the onNavigated seam. The focus-mode button (relocated from the quick
 * settings modal, owner 2026-10-14) renders beside them with pressed state.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  currentNavUrl,
  popStateNavHandler,
  recordNavPop,
  recordNavPush,
  type NavStack,
} from "../src/ui/App.js";
import { TopBar } from "../src/ui/components/TopBar.js";
import type { SyncStatusSnapshot } from "../src/core/workspace-client.js";

const SYNC: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

describe("the navigation stack tracker", () => {
  it("recordNavPush appends and truncates any forward tail", () => {
    let stack: NavStack = { entries: ["/a"], index: 0 };
    stack = recordNavPush(stack, "/b");
    stack = recordNavPush(stack, "/c");
    expect(stack).toEqual({ entries: ["/a", "/b", "/c"], index: 2 });
    // Back twice, then a new navigation: the forward tail dies.
    stack = recordNavPop(stack, "/b");
    stack = recordNavPop(stack, "/a");
    stack = recordNavPush(stack, "/d");
    expect(stack).toEqual({ entries: ["/a", "/d"], index: 1 });
  });

  it("recordNavPop steps toward the matching neighbor", () => {
    const stack: NavStack = { entries: ["/a", "/b", "/c"], index: 1 };
    expect(recordNavPop(stack, "/a")).toEqual({ entries: ["/a", "/b", "/c"], index: 0 });
    expect(recordNavPop(stack, "/c")).toEqual({ entries: ["/a", "/b", "/c"], index: 2 });
    expect(recordNavPop(stack, "/b")).toBe(stack); // same URL: no move
  });

  it("recordNavPop resets to a single-entry stack on a foreign URL", () => {
    const stack: NavStack = { entries: ["/a", "/b"], index: 1 };
    expect(recordNavPop(stack, "/typed-by-hand")).toEqual({
      entries: ["/typed-by-hand"],
      index: 0,
    });
  });

  it("currentNavUrl keys navigations by path + query", () => {
    expect(currentNavUrl({ pathname: "/search", search: "?q=note" })).toBe("/search?q=note");
    expect(currentNavUrl({ pathname: "/pages", search: "" })).toBe("/pages");
  });
});

describe("popStateNavHandler's onNavigated seam", () => {
  it("reports the landed URL (path + query) on every route branch", () => {
    const onNavigated = vi.fn();
    const handler = popStateNavHandler({
      openManager: () => {},
      closeManager: () => {},
      setNav: () => {},
      setNode: () => {},
      setSettingsSection: () => {},
      onNavigated,
    });

    window.history.replaceState({}, "", "/search?q=note");
    handler();
    expect(onNavigated).toHaveBeenLastCalledWith("/search?q=note");

    window.history.replaceState({}, "", "/pages");
    handler();
    expect(onNavigated).toHaveBeenLastCalledWith("/pages");

    window.history.replaceState({}, "", "/");
    handler();
    expect(onNavigated).toHaveBeenLastCalledWith("/");
  });
});

describe("the top bar Back/Forward arrows", () => {
  function renderBar(overrides: { canGoBack?: boolean; canGoForward?: boolean } = {}) {
    const onGoBack = vi.fn();
    const onGoForward = vi.fn();
    render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        onGoBack={onGoBack}
        onGoForward={onGoForward}
        canGoBack={overrides.canGoBack ?? false}
        canGoForward={overrides.canGoForward ?? false}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );
    return { onGoBack, onGoForward };
  }

  it("hidden without handlers (boot screens), rendered beside the breadcrumbs otherwise", () => {
    const { unmount } = render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    unmount();

    renderBar();
    expect(screen.getByRole("button", { name: "Back" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Forward" })).not.toBeNull();
  });

  it("disabled states ride the stack cursor; clicks fire the handlers", () => {
    const { onGoBack, onGoForward } = renderBar({ canGoBack: true });
    const back = screen.getByRole("button", { name: "Back" });
    const forward = screen.getByRole("button", { name: "Forward" });
    expect(back).toHaveProperty("disabled", false);
    expect(forward).toHaveProperty("disabled", true);

    fireEvent.click(back);
    expect(onGoBack).toHaveBeenCalledTimes(1);
    // A disabled arrow swallows the gesture.
    fireEvent.click(forward);
    expect(onGoForward).not.toHaveBeenCalled();
  });
});

describe("the top bar focus-mode button", () => {
  function renderBar(overrides: { focusMode?: boolean } = {}) {
    const onToggleFocusMode = vi.fn();
    render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
        onToggleFocusMode={onToggleFocusMode}
        focusMode={overrides.focusMode ?? false}
      />,
    );
    return { onToggleFocusMode };
  }

  it("hidden without a handler (boot screens), rendered with pressed state otherwise", () => {
    const { unmount } = render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Focus mode" })).toBeNull();
    unmount();

    renderBar();
    const button = screen.getByRole("button", { name: "Focus mode" });
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("the active state names the exit; clicks fire the handler", () => {
    const { onToggleFocusMode } = renderBar({ focusMode: true });
    const button = screen.getByRole("button", { name: "Exit focus mode" });
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);
    expect(onToggleFocusMode).toHaveBeenCalledTimes(1);
  });
});
