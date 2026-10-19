import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom lacks ResizeObserver; Tabs.List (workspace settings, the node
// picker's scope tabs, calendar surfaces) uses it for the active indicator.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom has no canvas backend: getContext would log a "Not implemented"
// virtual-console error on EVERY call (the context column mounts a graph
// card with each page view) before returning null. Return null quietly —
// the same value, without the noise; the graph's renderer-missing path
// renders its honest empty state either way.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

// jsdom lacks scrollIntoView; cmdk (the catalog command under the Dropdown
// combobox) scrolls the highlighted option into view unguarded.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
  if (typeof localStorage !== "undefined") localStorage.clear();
});
