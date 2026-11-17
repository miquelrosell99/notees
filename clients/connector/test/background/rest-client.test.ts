import { afterEach, describe, expect, it, vi } from "vitest";
import { captureViaRest } from "../../src/background/rest-client";
import { ConnectorSettings } from "../../src/shared/settings";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const settings: ConnectorSettings = {
  serverUrl: "https://host.example",
  apiKey: "nk_test",
  features: { bibliography: true, readLater: true },
};

const payload = { url: "https://example.com/a", title: "A", mode: "source" as const };

afterEach(() => fetchMock.mockReset());

describe("captureViaRest", () => {
  it("201 → ok with objectId/collectionId", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ objectId: "obj-1", collectionId: "col-1" }), { status: 201 }),
    );
    expect(await captureViaRest(settings, payload)).toEqual({
      ok: true,
      transport: "rest",
      objectId: "obj-1",
      collectionId: "col-1",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api/capture/web-page");
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("nk_test");
    expect(init.body).not.toContain("nk_test");
  });
  it("201 without collectionId (source mode) → ok, collectionId undefined", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ objectId: "obj-2" }), { status: 201 }));
    expect(await captureViaRest(settings, payload)).toEqual({
      ok: true,
      transport: "rest",
      objectId: "obj-2",
      collectionId: undefined,
    });
  });
  it("403 feature_disabled → mapped failure (normative {error:{code}} envelope)", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "feature_disabled",
            message: "the workspace's readItLater feature is disabled",
            status: 403,
          },
        }),
        { status: 403 },
      ),
    );
    expect(await captureViaRest(settings, payload)).toEqual({
      ok: false,
      error: { code: "feature_disabled", message: "the workspace's readItLater feature is disabled" },
    });
  });
  it("409 e2ee_required → mapped failure (normative body)", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "e2ee_required", message: "E2EE workspace", status: 409 } }),
        { status: 409 },
      ),
    );
    const out = await captureViaRest(settings, payload);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("e2ee_required");
      expect(out.error.message).toBe("E2EE workspace");
    }
  });
  it("401 → not_authenticated", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "unauthenticated", message: "bad key", status: 401 } }),
        { status: 401 },
      ),
    );
    const out = await captureViaRest(settings, payload);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("not_authenticated");
  });
  it("other non-JSON error status → http_error with status message", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 500 }));
    const out = await captureViaRest(settings, payload);
    expect(out).toEqual({ ok: false, error: { code: "http_error", message: "Server answered 500" } });
  });
  it("offline / unreachable → network_error, never throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("NetworkError"));
    expect(await captureViaRest(settings, payload)).toEqual({
      ok: false,
      error: { code: "network_error", message: "Could not reach the Notees server" },
    });
  });
  it("empty identifiers are omitted from the body", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ objectId: "obj-3" }), { status: 201 }));
    await captureViaRest(settings, { ...payload, identifiers: {} });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("identifiers");
  });
  it("populated identifiers ride the body", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ objectId: "obj-4" }), { status: 201 }));
    await captureViaRest(settings, { ...payload, identifiers: { doi: "10.1/x" }, note: "n" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      url: payload.url,
      title: payload.title,
      mode: "source",
      identifiers: { doi: "10.1/x" },
      note: "n",
    });
  });
});
