import { describe, expect, it } from "vitest";
import { apiUrl, createApiClient } from "../src/api/client";

describe("apiUrl", () => {
  it("accepts root-relative /api paths untouched (same-origin stays same-origin)", () => {
    expect(apiUrl("/api/relay/v2/stats")).toBe("/api/relay/v2/stats");
    expect(apiUrl("/api/relay/v2/ws-target?ticket=dummy")).toBe("/api/relay/v2/ws-target?ticket=dummy");
  });

  it("rejects absolute URLs before fetch can leak anything anywhere", () => {
    for (const bad of ["https://evil.example/api/x", "http://127.0.0.1:9999/api/x"]) {
      expect(() => apiUrl(bad)).toThrow(/root-relative/);
    }
  });

  it("rejects non-/api paths", () => {
    for (const bad of ["/api", "/apiary", "/", "api/x", "//evil/api/x"]) {
      expect(() => apiUrl(bad)).toThrow(/root-relative/);
    }
  });
});

describe("createApiClient", () => {
  it("fetches the relative path with the caller's init, through the injected fetch", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      fetchImpl: ((url: string, init?: RequestInit) => {
        calls.push({ url, init: init ?? {} });
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      }) as typeof fetch,
    });
    const response = await client.request("/api/relay/v2/stats", { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ url: "/api/relay/v2/stats", init: { method: "POST", body: "{}" } }]);
  });

  it("a non-/api path throws before fetch is called", async () => {
    let called = false;
    const client = createApiClient({
      fetchImpl: (() => {
        called = true;
        return Promise.resolve(new Response("no"));
      }) as typeof fetch,
    });
    await expect(client.request("/not-api")).rejects.toThrow(/root-relative/);
    expect(called).toBe(false);
  });
});
