import { afterEach, describe, expect, it, vi } from "vitest";
import browser from "webextension-polyfill";
import { fakeBrowser } from "@webext-core/fake-browser";
import { RELAY_TIMEOUT_MS, captureViaRelay } from "../../src/background/relay";

const payload = { url: "https://example.com/a", title: "A", mode: "source" as const };

function captureListener() {
  const listeners: ((msg: unknown) => void)[] = [];
  vi.spyOn(fakeBrowser.runtime.onMessage, "addListener").mockImplementation((fn) => {
    listeners.push(fn as (msg: unknown) => void);
  });
  return (msg: unknown) => {
    if (listeners.length === 0) throw new Error("no listener registered");
    for (const listener of listeners) listener(msg);
  };
}

afterEach(() => vi.restoreAllMocks());

describe("captureViaRelay", () => {
  it("resolves ok on relay-from-page ok", async () => {
    const emit = captureListener();
    vi.spyOn(browser.tabs, "sendMessage").mockResolvedValue(undefined as never);
    const promise = captureViaRelay(3, payload);
    emit({ source: "notees-connector", type: "relay-from-page", requestId: expect.any(String), ok: true, objectId: "obj-7" });
    const sent = vi.mocked(browser.tabs.sendMessage).mock.calls[0][1] as { requestId: string };
    emit({ source: "notees-connector", type: "relay-from-page", requestId: sent.requestId, ok: true, objectId: "obj-7" });
    expect(await promise).toEqual({ ok: true, transport: "tab-relay", objectId: "obj-7" });
  });

  it("two in-flight captures: swapped/out-of-order responses each resolve their own request", async () => {
    const emit = captureListener();
    vi.spyOn(browser.tabs, "sendMessage").mockResolvedValue(undefined as never);
    const promiseA = captureViaRelay(3, payload);
    const promiseB = captureViaRelay(4, payload);
    const [msgA, msgB] = vi.mocked(browser.tabs.sendMessage).mock.calls.map((c) => c[1]) as { requestId: string }[];
    // answer B first, with A's response arriving last — each promise must
    // still resolve with the objectId tied to its own requestId
    emit({ source: "notees-connector", type: "relay-from-page", requestId: msgB.requestId, ok: true, objectId: "obj-B" });
    emit({ source: "notees-connector", type: "relay-from-page", requestId: msgA.requestId, ok: true, objectId: "obj-A" });
    expect(await promiseA).toEqual({ ok: true, transport: "tab-relay", objectId: "obj-A" });
    expect(await promiseB).toEqual({ ok: true, transport: "tab-relay", objectId: "obj-B" });
  });

  it("removes its onMessage listener when settled (success and timeout) — no leak", async () => {
    const emit = captureListener();
    const addSpy = vi.mocked(fakeBrowser.runtime.onMessage.addListener);
    const removeSpy = vi.spyOn(fakeBrowser.runtime.onMessage, "removeListener");
    vi.spyOn(browser.tabs, "sendMessage").mockResolvedValue(undefined as never);

    const okPromise = captureViaRelay(3, payload);
    const sent = vi.mocked(browser.tabs.sendMessage).mock.calls[0][1] as { requestId: string };
    emit({ source: "notees-connector", type: "relay-from-page", requestId: sent.requestId, ok: true, objectId: "obj-1" });
    await okPromise;
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0][0]).toBe(addSpy.mock.calls[0][0]);

    vi.useFakeTimers();
    try {
      const timeoutPromise = captureViaRelay(3, payload);
      vi.advanceTimersByTime(RELAY_TIMEOUT_MS + 1);
      await timeoutPromise;
    } finally {
      vi.useRealTimers();
    }
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(addSpy).toHaveBeenCalledTimes(2);
  });

  it("resolves failure on relay-from-page error (e.g. logged-out tab)", async () => {
    const emit = captureListener();
    vi.spyOn(browser.tabs, "sendMessage").mockResolvedValue(undefined as never);
    const promise = captureViaRelay(3, payload);
    const sent = vi.mocked(browser.tabs.sendMessage).mock.calls[0][1] as { requestId: string };
    emit({ source: "notees-connector", type: "relay-from-page", requestId: sent.requestId, ok: false, error: { code: "not_authenticated", message: "no session" } });
    expect(await promise).toEqual({ ok: false, error: { code: "not_authenticated", message: "no session" } });
  });

  it("times out when the page never answers", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(browser.tabs, "sendMessage").mockResolvedValue(undefined as never);
      const promise = captureViaRelay(3, payload);
      vi.advanceTimersByTime(RELAY_TIMEOUT_MS + 1);
      expect(await promise).toEqual({ ok: false, error: { code: "failed", message: "The Notees tab did not answer" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails cleanly when sendMessage rejects (tab navigated away)", async () => {
    vi.spyOn(browser.tabs, "sendMessage").mockRejectedValue(new Error("no receiver") as never);
    expect(await captureViaRelay(3, payload)).toEqual({ ok: false, error: { code: "failed", message: "Could not reach the Notees tab" } });
  });
});
