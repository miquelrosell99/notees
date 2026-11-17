import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  execSync("pnpm build", { stdio: "inherit" });
});

describe("built extension", () => {
  it("manifest references files that exist in dist/", () => {
    const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    for (const script of manifest.background.scripts) {
      expect(existsSync(`dist/${script}`), `dist/${script}`).toBe(true);
    }
    expect(existsSync(`dist/${manifest.options_ui.page}`)).toBe(true);
    expect(existsSync(`dist/${manifest.browser_action.default_icon}`)).toBe(true);
    for (const icon of Object.values(manifest.icons) as string[]) {
      expect(existsSync(`dist/${icon}`), `dist/${icon}`).toBe(true);
    }
  });
  it("background bundle contains no bare module imports (content-script-safe IIFE)", () => {
    const bg = readFileSync("dist/background.js", "utf8");
    expect(bg).not.toMatch(/^import /m);
  });
  it("content bridge bundle exposes the install guard", () => {
    const bridge = readFileSync("dist/content-bridge.js", "utf8");
    expect(bridge).toContain("__noteesConnectorBridgeInstalled");
  });
});
