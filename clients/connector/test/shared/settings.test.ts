import { describe, expect, it } from "vitest";
import browser from "webextension-polyfill";
import { loadSettings, normalizeServerUrl, saveSettings } from "../../src/shared/settings";

describe("normalizeServerUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeServerUrl("https://host.example/")).toBe("https://host.example");
    expect(normalizeServerUrl("https://host.example///")).toBe("https://host.example");
  });
  it("drops paths, queries and fragments, trims whitespace", () => {
    expect(normalizeServerUrl("  https://host.example/app/?x=1#y ")).toBe("https://host.example");
  });
  it("keeps non-default ports", () => {
    expect(normalizeServerUrl("http://lan-ip:8377/")).toBe("http://lan-ip:8377");
  });
  it("returns empty string for empty input", () => {
    expect(normalizeServerUrl("")).toBe("");
    expect(normalizeServerUrl("   ")).toBe("");
  });
  it("throws on garbage and non-http schemes", () => {
    expect(() => normalizeServerUrl("host.example")).toThrow(/scheme/);
    expect(() => normalizeServerUrl("ftp://host.example")).toThrow(/http/);
  });
  it("throws on credentials embedded in the URL", () => {
    expect(() => normalizeServerUrl("https://user:pass@host.example")).toThrow(/credentials/);
    expect(() => normalizeServerUrl("https://token@host.example/")).toThrow(/credentials/);
  });
});

describe("settings storage", () => {
  it("round-trips through browser.storage.local under the \"settings\" key", async () => {
    const settings = {
      serverUrl: "https://host.example",
      apiKey: "nk_test",
      features: { bibliography: false, readLater: true },
    };
    await saveSettings(settings);
    expect(await browser.storage.local.get("settings")).toEqual({ settings });
    expect(await loadSettings()).toEqual(settings);
  });
  it("fills defaults for missing or malformed stored values", async () => {
    await browser.storage.local.set({ settings: { serverUrl: 42, apiKey: "nk_x" } });
    expect(await loadSettings()).toEqual({
      serverUrl: "",
      apiKey: "nk_x",
      features: { bibliography: true, readLater: true },
    });
  });
});
