import { describe, expect, it, vi } from "vitest";
import browser from "webextension-polyfill";
import { fakeBrowser } from "@webext-core/fake-browser";
import { ensureBridge, findNoteesTab } from "../../src/background/tabs";

describe("findNoteesTab", () => {
  it("matches only tabs on the configured server origin", async () => {
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([
      { id: 1, url: "https://host.example/app/page" },
      { id: 2, url: "https://other.example/" },
      { id: 3, url: "https://host.example.evil/" },
      { id: 4, url: undefined },
    ] as never);
    const tab = await findNoteesTab("https://host.example");
    expect(tab?.id).toBe(1);
  });
  it("normalizes the configured serverUrl before matching", async () => {
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([
      { id: 1, url: "https://host.example/app/page" },
    ] as never);
    expect((await findNoteesTab("https://host.example/"))?.id).toBe(1);
    expect((await findNoteesTab(" https://host.example/app "))?.id).toBe(1);
  });
  it("returns null for a garbage or empty serverUrl", async () => {
    const query = vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([
      { id: 1, url: "https://host.example/app/page" },
    ] as never);
    expect(await findNoteesTab("")).toBeNull();
    expect(await findNoteesTab("not-a-url")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it("never matches about:blank or chrome:// tab URLs (no host to compare)", async () => {
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([
      { id: 1, url: "about:blank" },
      { id: 2, url: "about:preferences" },
      { id: 3, url: "chrome://extensions/" },
      { id: 4, url: "moz-extension://abc/options.html" },
    ] as never);
    expect(await findNoteesTab("https://host.example")).toBeNull();
  });
  it("matches a server-origin tab even when unmatchable URLs sit beside it", async () => {
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([
      { id: 1, url: "about:blank" },
      { id: 2, url: "https://host.example/app" },
      { id: 3, url: "chrome://extensions/" },
    ] as never);
    expect((await findNoteesTab("https://host.example"))?.id).toBe(2);
  });
  it("returns null when no matching tab", async () => {
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([{ id: 2, url: "https://other.example/" }] as never);
    expect(await findNoteesTab("https://host.example")).toBeNull();
  });
});

describe("ensureBridge", () => {
  it("injects the bridge script into the given tab", async () => {
    const spy = vi.spyOn(browser.tabs, "executeScript").mockResolvedValue([undefined] as never);
    await ensureBridge(7);
    expect(spy).toHaveBeenCalledWith(7, { file: "content-bridge.js" });
  });
  it("tolerates duplicate injection — no state, no error", async () => {
    const spy = vi.spyOn(browser.tabs, "executeScript").mockResolvedValue([undefined] as never);
    await ensureBridge(7);
    await ensureBridge(7);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
