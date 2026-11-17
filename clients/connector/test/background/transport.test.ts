import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tabs } from "webextension-polyfill";
import type { ConnectorSettings } from "../../src/shared/settings";
import { createTransport, TransportDeps } from "../../src/background/transport";

const settings = (over: Partial<ConnectorSettings> = {}): ConnectorSettings => ({
  serverUrl: "https://host.example",
  apiKey: "nk_test",
  features: { bibliography: true, readLater: true },
  ...over,
});
const payload = { url: "https://example.com/a", title: "A", mode: "source" as const };

function makeDeps() {
  return {
    findNoteesTab: vi.fn<TransportDeps["findNoteesTab"]>(),
    ensureBridge: vi.fn<TransportDeps["ensureBridge"]>(),
    captureViaRelay: vi.fn<TransportDeps["captureViaRelay"]>(),
    captureViaRest: vi.fn<TransportDeps["captureViaRest"]>(),
  };
}
const tab = (id: number) => ({ id }) as Tabs.Tab;

beforeEach(() => vi.clearAllMocks());

describe("selectTransport", () => {
  it("Notees tab open → tab-relay", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(tab(5));
    expect(await createTransport(deps).selectTransport(settings())).toBe("tab-relay");
  });
  it("no matching tab → rest", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(null);
    expect(await createTransport(deps).selectTransport(settings())).toBe("rest");
  });
});

describe("captureWithTransport", () => {
  it("Notees tab open → relay; success returns without touching REST", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(tab(5));
    deps.captureViaRelay.mockResolvedValue({ ok: true, transport: "tab-relay", objectId: "o1" });
    expect(await createTransport(deps).captureWithTransport(settings(), payload))
      .toEqual({ ok: true, transport: "tab-relay", objectId: "o1" });
    expect(deps.ensureBridge).toHaveBeenCalledWith(5);
    expect(deps.captureViaRest).not.toHaveBeenCalled();
  });

  it("logged-out tab → not_authenticated is final (no REST fallback)", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(tab(5));
    deps.captureViaRelay.mockResolvedValue({ ok: false, error: { code: "not_authenticated", message: "no session" } });
    const out = await createTransport(deps).captureWithTransport(settings(), payload);
    expect(out).toEqual({ ok: false, error: { code: "not_authenticated", message: "no session" } });
    expect(deps.captureViaRest).not.toHaveBeenCalled();
  });

  it("relay feature_disabled is final (no REST fallback)", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(tab(5));
    deps.captureViaRelay.mockResolvedValue({ ok: false, error: { code: "feature_disabled", message: "read-later is off in Notees" } });
    const out = await createTransport(deps).captureWithTransport(settings(), payload);
    expect(out).toEqual({ ok: false, error: { code: "feature_disabled", message: "read-later is off in Notees" } });
    expect(deps.captureViaRest).not.toHaveBeenCalled();
  });

  it("REST feature_disabled passes through untouched (server's definitive answer)", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(null);
    deps.captureViaRest.mockResolvedValue({ ok: false, error: { code: "feature_disabled", message: "read-later is off in Notees" } });
    expect(await createTransport(deps).captureWithTransport(settings(), payload))
      .toEqual({ ok: false, error: { code: "feature_disabled", message: "read-later is off in Notees" } });
    expect(deps.captureViaRest).toHaveBeenCalledTimes(1);
  });

  it("relay e2ee_required is final (no REST fallback)", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(tab(5));
    deps.captureViaRelay.mockResolvedValue({ ok: false, error: { code: "e2ee_required", message: "workspace is end-to-end encrypted" } });
    const out = await createTransport(deps).captureWithTransport(settings(), payload);
    expect(out).toEqual({ ok: false, error: { code: "e2ee_required", message: "workspace is end-to-end encrypted" } });
    expect(deps.captureViaRest).not.toHaveBeenCalled();
  });

  it("relay generic failure → falls back to REST", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(tab(5));
    deps.captureViaRelay.mockResolvedValue({ ok: false, error: { code: "failed", message: "tab did not answer" } });
    deps.captureViaRest.mockResolvedValue({ ok: true, transport: "rest", objectId: "o2" });
    expect(await createTransport(deps).captureWithTransport(settings(), payload))
      .toEqual({ ok: true, transport: "rest", objectId: "o2" });
  });

  it("bridge injection rejects (tab closed mid-capture) → falls back to REST, not a final failure", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(tab(5));
    deps.ensureBridge.mockRejectedValue(new Error("tab 5 is gone"));
    deps.captureViaRest.mockResolvedValue({ ok: true, transport: "rest", objectId: "o3" });
    expect(await createTransport(deps).captureWithTransport(settings(), payload))
      .toEqual({ ok: true, transport: "rest", objectId: "o3" });
    expect(deps.captureViaRelay).not.toHaveBeenCalled();
  });

  it("offline, no tab, has key → REST outcome (network_error) passes through", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(null);
    deps.captureViaRest.mockResolvedValue({ ok: false, error: { code: "network_error", message: "Could not reach the Notees server" } });
    expect(await createTransport(deps).captureWithTransport(settings(), payload))
      .toEqual({ ok: false, error: { code: "network_error", message: "Could not reach the Notees server" } });
  });

  it("REST 409 e2ee_required passes through untouched (notification layer turns it into 'open Notees')", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(null);
    deps.captureViaRest.mockResolvedValue({ ok: false, error: { code: "e2ee_required", message: "workspace is end-to-end encrypted" } });
    expect(await createTransport(deps).captureWithTransport(settings(), payload))
      .toEqual({ ok: false, error: { code: "e2ee_required", message: "workspace is end-to-end encrypted" } });
  });

  it("no tab and no API key → not_authenticated without calling REST", async () => {
    const deps = makeDeps();
    deps.findNoteesTab.mockResolvedValue(null);
    const out = await createTransport(deps).captureWithTransport(settings({ apiKey: "" }), payload);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("not_authenticated");
    expect(deps.captureViaRest).not.toHaveBeenCalled();
  });

  it("no serverUrl configured at all → straight to REST path guard, never queries tabs", async () => {
    const deps = makeDeps();
    deps.captureViaRest.mockResolvedValue({ ok: true, transport: "rest", objectId: "o4" });
    const out = await createTransport(deps).captureWithTransport(settings({ serverUrl: "" }), payload);
    expect(out.ok).toBe(true);
    expect(deps.findNoteesTab).not.toHaveBeenCalled();
  });
});
