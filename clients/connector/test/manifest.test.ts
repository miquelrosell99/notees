import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));

describe("manifest", () => {
  it("is Manifest V2 for Firefox", () => {
    expect(manifest.manifest_version).toBe(2);
    expect(manifest.background.scripts).toContain("background.js");
  });
  it("declares no static content scripts and no static host permissions", () => {
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.host_permissions).toBeUndefined();
  });
  it("carries optional host permissions for runtime origin grants", () => {
    expect(manifest.optional_permissions).toEqual(
      expect.arrayContaining(["https://*/*", "http://*/*"]),
    );
  });
  it("has an options page and the keyboard command", () => {
    expect(manifest.options_ui.page).toBe("options.html");
    expect(manifest.commands["_execute_browser_action"].suggested_key.default).toBe("Ctrl+Alt+S");
  });
});
