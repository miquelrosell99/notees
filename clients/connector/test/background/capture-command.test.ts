import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tabs } from "webextension-polyfill";
import { fakeBrowser } from "@webext-core/fake-browser";
import type { ConnectorSettings } from "../../src/shared/settings";
import { performCapture, CaptureTransport } from "../../src/background/capture-command";
import { extractIdentifiers } from "../../src/capture/extract-in-page";

vi.mock("../../src/capture/extract-in-page", () => ({ extractIdentifiers: vi.fn() }));

const settings: ConnectorSettings = {
  serverUrl: "https://host.example",
  apiKey: "nk_test",
  features: { bibliography: true, readLater: true },
};
const tab = { id: 9, url: "https://example.com/paper", title: "A paper" } as Tabs.Tab;

const captureWithTransport = vi.fn();
const transport = { captureWithTransport } as unknown as CaptureTransport;

beforeEach(() => {
  vi.restoreAllMocks();
  fakeBrowser.reset();
  vi.clearAllMocks();
});

describe("performCapture (source mode)", () => {
  it("attaches DOI identifiers and notifies on success", async () => {
    const create = vi.spyOn(fakeBrowser.notifications, "create");
    vi.mocked(extractIdentifiers).mockResolvedValue({ doi: "10.1234/foo" });
    captureWithTransport.mockResolvedValue({ ok: true, transport: "rest", objectId: "o1" });
    await performCapture("source", tab, settings, transport);
    expect(captureWithTransport).toHaveBeenCalledWith(settings, {
      url: "https://example.com/paper",
      title: "A paper",
      mode: "source",
      identifiers: { doi: "10.1234/foo" },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Saved to bibliography", message: expect.stringContaining("A paper") }),
    );
  });
  it("omits the identifiers key when no DOI/ISBN meta was found", async () => {
    vi.mocked(extractIdentifiers).mockResolvedValue({});
    captureWithTransport.mockResolvedValue({ ok: true, transport: "rest", objectId: "o1" });
    await performCapture("source", tab, settings, transport);
    expect(captureWithTransport).toHaveBeenCalledWith(settings, {
      url: "https://example.com/paper",
      title: "A paper",
      mode: "source",
    });
    const payload = captureWithTransport.mock.calls[0][1] as Record<string, unknown>;
    expect("identifiers" in payload).toBe(false);
  });
  it("link capture skips identifier extraction even when the page has a citation_doi meta", async () => {
    vi.mocked(extractIdentifiers).mockResolvedValue({ doi: "10.1234/foo" });
    captureWithTransport.mockResolvedValue({ ok: true, transport: "rest", objectId: "o3" });
    const linkTab = { id: 9, url: "https://elsewhere.example/paper.pdf", title: "Linked paper" } as Tabs.Tab;
    await performCapture("source", linkTab, settings, transport, { isLinkCapture: true });
    expect(extractIdentifiers).not.toHaveBeenCalled();
    expect(captureWithTransport).toHaveBeenCalledWith(settings, {
      url: "https://elsewhere.example/paper.pdf",
      title: "Linked paper",
      mode: "source",
    });
    const payload = captureWithTransport.mock.calls[0][1] as Record<string, unknown>;
    expect("identifiers" in payload).toBe(false);
  });
  it("capture failure maps to notifyFailure", async () => {
    const create = vi.spyOn(fakeBrowser.notifications, "create");
    vi.mocked(extractIdentifiers).mockResolvedValue({});
    captureWithTransport.mockResolvedValue({ ok: false, error: { code: "e2ee_required", message: "E2EE" } });
    await performCapture("source", tab, settings, transport);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Open Notees to capture" }),
    );
  });
  it("falls back to the URL when the tab has no title", async () => {
    vi.mocked(extractIdentifiers).mockResolvedValue({});
    captureWithTransport.mockResolvedValue({ ok: true, transport: "rest", objectId: "o1" });
    await performCapture("source", { id: 9, url: "https://example.com/paper", title: "" } as Tabs.Tab, settings, transport);
    expect(captureWithTransport).toHaveBeenCalledWith(settings, {
      url: "https://example.com/paper",
      title: "https://example.com/paper",
      mode: "source",
    });
  });
});

describe("performCapture (readlater mode)", () => {
  it("skips DOI extraction (identifiers are REST+source only) — no identifiers key at all", async () => {
    const create = vi.spyOn(fakeBrowser.notifications, "create");
    captureWithTransport.mockResolvedValue({ ok: true, transport: "tab-relay", objectId: "o2" });
    await performCapture("readlater", tab, settings, transport);
    expect(extractIdentifiers).not.toHaveBeenCalled();
    expect(captureWithTransport).toHaveBeenCalledWith(settings, {
      url: "https://example.com/paper",
      title: "A paper",
      mode: "readlater",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Saved to Read later" }),
    );
  });
  it("notifies when the feature toggle is off, without capturing", async () => {
    const create = vi.spyOn(fakeBrowser.notifications, "create");
    await performCapture("readlater", tab, { ...settings, features: { bibliography: true, readLater: false } }, transport);
    expect(captureWithTransport).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Feature not enabled" }),
    );
  });
  it("notifies when the tab has no id or url, without capturing", async () => {
    const create = vi.spyOn(fakeBrowser.notifications, "create");
    await performCapture("source", { url: "https://example.com/paper" } as Tabs.Tab, settings, transport);
    await performCapture("source", { id: 9 } as Tabs.Tab, settings, transport);
    expect(captureWithTransport).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Nothing to capture here" }),
    );
  });
});
