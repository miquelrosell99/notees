/**
 * Keymap chords — the standalone handler factories from App.tsx
 * (same harness style as the openTodayKeyHandler specs in
 * day-features.test.tsx):
 *
 * - historyNavKeyHandler: Alt+← / Alt+→ drive window.history back/forward
 *   through the existing nav state (the popstate effect maps the stack),
 *   guarded from form fields.
 * - keymapChordHandler: Ctrl/Cmd+N new page (create + open), Ctrl/Cmd+,
 *   settings, Ctrl/Cmd+\ sidebar toggle — all guarded from form fields.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { historyNavKeyHandler, keymapChordHandler } from "../src/ui/App.js";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

function dispatch(event: KeyboardEvent): void {
  document.dispatchEvent(event);
}

describe("historyNavKeyHandler (Alt+← / Alt+→)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Alt+ArrowLeft goes back through the history stack", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const handler = historyNavKeyHandler();
    document.addEventListener("keydown", handler);
    const event = key({ key: "ArrowLeft", altKey: true });
    dispatch(event);
    document.removeEventListener("keydown", handler);
    expect(back).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Alt+ArrowRight goes forward through the history stack", () => {
    const forward = vi.spyOn(window.history, "forward").mockImplementation(() => {});
    const handler = historyNavKeyHandler();
    document.addEventListener("keydown", handler);
    const event = key({ key: "ArrowRight", altKey: true });
    dispatch(event);
    document.removeEventListener("keydown", handler);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps the keystroke inside form fields", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const handler = historyNavKeyHandler();
    document.addEventListener("keydown", handler);
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = key({ key: "ArrowLeft", altKey: true });
    input.dispatchEvent(event);
    document.removeEventListener("keydown", handler);
    input.remove();
    expect(back).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores modified variants (Ctrl+Alt+arrows belong to the fold chords)", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const forward = vi.spyOn(window.history, "forward").mockImplementation(() => {});
    const handler = historyNavKeyHandler();
    document.addEventListener("keydown", handler);
    dispatch(key({ key: "ArrowLeft", altKey: true, ctrlKey: true }));
    dispatch(key({ key: "ArrowRight", altKey: true, metaKey: true }));
    dispatch(key({ key: "ArrowLeft", altKey: true, shiftKey: true }));
    document.removeEventListener("keydown", handler);
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("ignores plain Alt and plain arrows", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const handler = historyNavKeyHandler();
    document.addEventListener("keydown", handler);
    dispatch(key({ key: "ArrowLeft" }));
    dispatch(key({ key: "a", altKey: true }));
    document.removeEventListener("keydown", handler);
    expect(back).not.toHaveBeenCalled();
  });
});

describe("keymapChordHandler (Ctrl/Cmd+N , , \\)", () => {
  function setup() {
    const createObject = vi.fn().mockResolvedValue("0192a000-0000-7000-8000-000000000099");
    const openPage = vi.fn();
    const openSettings = vi.fn();
    const toggleSidebar = vi.fn();
    const handler = keymapChordHandler({
      client: () => ({ createObject }) as never,
      openPage,
      openSettings,
      toggleSidebar,
    });
    document.addEventListener("keydown", handler);
    return {
      createObject,
      openPage,
      openSettings,
      toggleSidebar,
      release: () => document.removeEventListener("keydown", handler),
    };
  }

  it("Ctrl+N creates a page and opens it", async () => {
    const h = setup();
    const event = key({ key: "n", ctrlKey: true });
    dispatch(event);
    h.release();
    expect(event.defaultPrevented).toBe(true);
    expect(h.createObject).toHaveBeenCalledWith({ presentAsMain: true, name: "Untitled" });
    await vi.waitFor(() => expect(h.openPage).toHaveBeenCalledWith("0192a000-0000-7000-8000-000000000099"));
  });

  it("Ctrl+, opens settings", () => {
    const h = setup();
    const event = key({ key: ",", ctrlKey: true });
    dispatch(event);
    h.release();
    expect(event.defaultPrevented).toBe(true);
    expect(h.openSettings).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+\\ toggles the sidebar", () => {
    const h = setup();
    const event = key({ key: "\\", ctrlKey: true });
    dispatch(event);
    h.release();
    expect(event.defaultPrevented).toBe(true);
    expect(h.toggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("keeps every chord inside form fields", () => {
    const h = setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    for (const k of ["n", ",", "\\"]) {
      input.dispatchEvent(key({ key: k, ctrlKey: true }));
    }
    input.remove();
    h.release();
    expect(h.createObject).not.toHaveBeenCalled();
    expect(h.openSettings).not.toHaveBeenCalled();
    expect(h.toggleSidebar).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+N stays with quick add (not the new-page chord)", () => {
    const h = setup();
    dispatch(key({ key: "N", ctrlKey: true, shiftKey: true }));
    h.release();
    expect(h.createObject).not.toHaveBeenCalled();
  });
});
