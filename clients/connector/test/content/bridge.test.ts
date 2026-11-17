// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

async function importBridge() {
  // fresh module per test so the install guard re-runs
  vi.resetModules();
  return import("../../src/content/bridge");
}

describe("content bridge", () => {
  it("forwards relay-to-page runtime messages to the page as notees-capture-request", async () => {
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data) => sent.push(data));
    // fake-browser 1.3.4 does not expose onMessage.listeners; capture the
    // registered callback instead (brief's sanctioned fallback).
    const addListener = vi.spyOn(fakeBrowser.runtime.onMessage, "addListener");
    await importBridge();
    const listener = addListener.mock.calls[0][0] as (msg: unknown) => void;
    listener({
      source: "notees-connector",
      type: "relay-to-page",
      requestId: "r1",
      payload: { url: "https://example.com/a", title: "A", mode: "readlater" },
    });
    expect(sent).toEqual([
      {
        source: "notees-connector",
        type: "notees-capture-request",
        requestId: "r1",
        payload: { url: "https://example.com/a", title: "A", mode: "readlater" },
      },
    ]);
  });

  it("forwards page notees-capture-response messages to the background as relay-from-page", async () => {
    const spy = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined as never);
    await importBridge();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: {
          source: "notees-connector",
          type: "notees-capture-response",
          requestId: "r2",
          ok: false,
          error: { code: "not_authenticated", message: "no session" },
        },
      }),
    );
    expect(spy).toHaveBeenCalledWith({
      source: "notees-connector",
      type: "relay-from-page",
      requestId: "r2",
      ok: false,
      error: { code: "not_authenticated", message: "no session" },
    });
  });

  it("ignores foreign messages", async () => {
    const spy = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined as never);
    await importBridge();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: { source: "evil", type: "notees-capture-response", requestId: "x", ok: true, objectId: "y" },
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("installs only once even when the guard flag is cleared (second injection, same window)", async () => {
    const addListener = vi.spyOn(fakeBrowser.runtime.onMessage, "addListener");
    const windowAdd = vi.spyOn(window, "addEventListener");
    await importBridge();
    // simulate a second executeScript injection into the same page window:
    // wipe the guard flag and re-evaluate the module — a broken guard would
    // register a second listener set
    delete window.__noteesConnectorBridgeInstalled;
    await importBridge();
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(windowAdd.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
  });
});
