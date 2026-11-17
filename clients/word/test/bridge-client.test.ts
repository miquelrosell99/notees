import { describe, expect, it } from "vitest";
import { createBridge, BridgeOfflineError, BridgeShapeError } from "../src/bridge/client";

function stubFetch(handler: (url: string, init: RequestInit) => unknown, status = 200): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const body = handler(String(url), init ?? {});
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("createBridge", () => {
  it("posts to /document with cmd, bearer token, and merged body", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const b = createBridge({ port: 8474, token: "tok", fetchImpl: stubFetch((url, init) => {
      seen = { url, init };
      return { ok: true, citation: "(Doe 2024)" };
    }) });
    const r = await b.renderCitation(["n1"], "apa", "p. 3");
    expect(r).toEqual({ ok: true, citation: "(Doe 2024)" });
    expect(seen!.url).toBe("http://127.0.0.1:8474/document");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ cmd: "render-citation", objectIds: ["n1"], styleId: "apa", locator: "p. 3" });
  });

  it("omits locator when undefined", async () => {
    let body: Record<string, unknown> = {};
    const b = createBridge({ port: 1, token: "t", fetchImpl: stubFetch((_u, init) => {
      body = JSON.parse(init.body as string);
      return { ok: true, citation: "x" };
    }) });
    await b.renderCitation(["n1"], "apa");
    expect(body).not.toHaveProperty("locator");
  });

  it("returns ok:false with code, message, and HTTP status from an error envelope", async () => {
    const b = createBridge({ port: 1, token: "t", fetchImpl: stubFetch(() => ({ ok: false, error: { code: "unknown_style", message: "no such style" } })) });
    const r = await b.search("doe");
    expect(r).toEqual({ ok: false, error: { code: "unknown_style", message: "no such style", status: 200 } });
  });

  it("carries the HTTP 401 status on a generic bad_request body (wrong pairing token)", async () => {
    const b = createBridge({ port: 8474, token: "wrong-token", fetchImpl: stubFetch(() => ({ ok: false, error: { code: "bad_request", message: "unauthorized" } }), 401) });
    const r = await b.listStyles();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(401);
  });

  it("throws BridgeOfflineError on connection refusal", async () => {
    const b = createBridge({ port: 1, token: "t", fetchImpl: stubFetch(() => new Error("ECONNREFUSED")) });
    await expect(b.search("x")).rejects.toBeInstanceOf(BridgeOfflineError);
  });

  it("maps search results to the normative result shape", async () => {
    const b = createBridge({ port: 1, token: "t", fetchImpl: stubFetch(() => ({ ok: true, results: [{ objectId: "n1", title: "Paper", citekey: "doe2024paper", authors: ["Doe"], year: 2024, classKey: "source" }] })) });
    const r = await b.search("paper");
    if (!r.ok) throw new Error("expected ok");
    expect(r.results[0]).toEqual({ objectId: "n1", title: "Paper", citekey: "doe2024paper", authors: ["Doe"], year: 2024, classKey: "source" });
  });

  it("rejects a non-integer or out-of-range port before calling fetch", () => {
    let called = false;
    const fetchImpl = stubFetch(() => { called = true; return { ok: true, results: [] }; });
    for (const port of [-1, 65536, 1.5, NaN]) {
      expect(() => createBridge({ port, token: "t", fetchImpl })).toThrow(RangeError);
    }
    expect(called).toBe(false);
  });

  it("passes a 5s AbortSignal with each request", async () => {
    let seen: RequestInit | null = null;
    const b = createBridge({ port: 8474, token: "t", fetchImpl: stubFetch((_u, init) => {
      seen = init;
      return { ok: true, styles: [] };
    }) });
    await b.listStyles();
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
    expect((seen!.signal as AbortSignal).aborted).toBe(false);
  });

  it("throws BridgeShapeError when an ok envelope misses a required key", async () => {
    const b = createBridge({ port: 1, token: "t", fetchImpl: stubFetch(() => ({ ok: true })) });
    await expect(b.listStyles()).rejects.toBeInstanceOf(BridgeShapeError);
  });
});
