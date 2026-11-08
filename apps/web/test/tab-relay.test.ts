import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installTabRelay,
  isAllowedOrigin,
  isCaptureRequest,
  type CaptureResponseMessage,
  type TabRelayHost,
} from "../src/features/connector/tabRelay.js";

const SERVER_ORIGIN = "https://notees.example.com";

function postFrom(
  win: Window,
  opts: { origin: string; data: unknown },
): void {
  // jsdom: a synthetic MessageEvent with a window source exercises the
  // same code path the browser delivers.
  win.dispatchEvent(
    new MessageEvent("message", { origin: opts.origin, source: win, data: opts.data }),
  );
}

const REQUEST = {
  source: "notees-connector",
  type: "notees-capture-request",
  requestId: "req-1",
  payload: { url: "https://example.com/a", title: "A", mode: "source" },
};

describe("isCaptureRequest", () => {
  it("accepts the normative shape; rejects everything else", () => {
    expect(isCaptureRequest(REQUEST)).toBe(true);
    expect(isCaptureRequest({ ...REQUEST, source: "other" })).toBe(false);
    expect(isCaptureRequest({ ...REQUEST, type: "notees-capture-response" })).toBe(false);
    expect(isCaptureRequest({ ...REQUEST, payload: { ...REQUEST.payload, mode: "body" } })).toBe(false);
    expect(isCaptureRequest({ ...REQUEST, payload: { ...REQUEST.payload, url: 42 } })).toBe(false);
    expect(isCaptureRequest("notees-capture-request")).toBe(false);
    expect(isCaptureRequest(null)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("is an exact match against the configured server origin", () => {
    expect(isAllowedOrigin(SERVER_ORIGIN, SERVER_ORIGIN)).toBe(true);
    expect(isAllowedOrigin("https://evil.example.com", SERVER_ORIGIN)).toBe(false);
    expect(isAllowedOrigin("null", SERVER_ORIGIN)).toBe(false);
  });
});

describe("installTabRelay", () => {
  const unmounts: Array<() => void> = [];
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()!();
    vi.restoreAllMocks();
  });

  function host(overrides: Partial<TabRelayHost> = {}): TabRelayHost & { handleCapture: ReturnType<typeof vi.fn> } {
    const handleCapture = vi.fn(async () => ({ ok: true as const, objectId: "obj-1" }));
    // DEVIATION from the brief: the verbatim return fails tsc — spreading
    // Partial<TabRelayHost> widens handleCapture to the plain function
    // type, which is not assignable to the declared Mock intersection. The
    // cast restores the brief's declared return type.
    return {
      serverOrigin: () => SERVER_ORIGIN,
      handleCapture,
      ...overrides,
    } as TabRelayHost & { handleCapture: ReturnType<typeof vi.fn> };
  }

  function listen(h: TabRelayHost): { sent: CaptureResponseMessage[] } {
    const sent: CaptureResponseMessage[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
      sent.push(data as CaptureResponseMessage);
    });
    unmounts.push(installTabRelay(window, h));
    return { sent };
  }

  it("answers a valid request through the host and echoes requestId", async () => {
    const h = host();
    const { sent } = listen(h);
    postFrom(window, { origin: SERVER_ORIGIN, data: REQUEST });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      source: "notees-connector",
      type: "notees-capture-response",
      requestId: "req-1",
      ok: true,
      objectId: "obj-1",
    });
    expect(h.handleCapture).toHaveBeenCalledWith(REQUEST.payload);
  });

  it("silently ignores a foreign origin and a non-window source", async () => {
    const h = host();
    const { sent } = listen(h);
    postFrom(window, { origin: "https://evil.example.com", data: REQUEST });
    // DEVIATION from the brief: it posted a WELL-FORMED request from the
    // allowed origin here ({ ...REQUEST, requestId: "req-x" }) — the relay
    // must and does answer that (verified: sent.length 1 against the
    // verbatim implementation), so the case is replaced with a malformed-
    // payload message from the allowed origin, which exercises the shape
    // guard inside the listener. The test's intent — three ignored inputs,
    // zero answers — is preserved.
    postFrom(window, {
      origin: SERVER_ORIGIN,
      data: { ...REQUEST, payload: { ...REQUEST.payload, mode: "body" } },
    });
    window.dispatchEvent(
      new MessageEvent("message", { origin: SERVER_ORIGIN, source: null, data: REQUEST }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(0);
    expect(h.handleCapture).not.toHaveBeenCalled();
  });

  it("maps the host's error codes verbatim", async () => {
    const h = host({
      handleCapture: vi.fn(async () => ({
        ok: false as const,
        code: "feature_disabled" as const,
        message: "Read later is off for this workspace.",
      })),
    });
    const { sent } = listen(h);
    postFrom(window, { origin: SERVER_ORIGIN, data: REQUEST });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, requestId: "req-1", error: { code: "feature_disabled" } });
  });

  it("a null serverOrigin means no session — answers not_authenticated, never dispatches", async () => {
    const h = host({ serverOrigin: () => null });
    const { sent } = listen(h);
    postFrom(window, { origin: "https://anything.example.com", data: REQUEST });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, error: { code: "not_authenticated" } });
    expect(h.handleCapture).not.toHaveBeenCalled();
  });

  it("uninstall stops answering", async () => {
    const h = host();
    const { sent } = listen(h);
    unmounts.pop()!(); // uninstall
    postFrom(window, { origin: SERVER_ORIGIN, data: REQUEST });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(0);
  });
});
