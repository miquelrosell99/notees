import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";

// Scaffold smoke test: asserts the dist/ layout the sync server serves at /word/.
// Requires a prior `pnpm build`.

describe("build output", () => {
  it("vendored office.js ships in dist/lib (no CDN at runtime)", () => {
    expect(existsSync("dist/lib/office.js")).toBe(true);
  });

  it("vendored office.js is the real library, not a stub", () => {
    // Existence alone is vacuous — a placeholder file would pass it.
    const { size } = statSync("dist/lib/office.js");
    expect(size).toBeGreaterThan(50 * 1024);
  });

  it("dist/index.html uses relative asset URLs", () => {
    const html = readFileSync("dist/index.html", "utf8");
    expect(html).toMatch(/src="\.\/assets\//);
    expect(html).toContain('src="./lib/office.js"');
  });

  it("manifest declares WordApi 1.5 and the local bridge domain", () => {
    const manifest = readFileSync("dist/manifest.xml", "utf8");
    expect(manifest).toContain('Set Name="WordApi" MinVersion="1.5"');
    expect(manifest).toContain("<AppDomain>http://127.0.0.1</AppDomain>");
    expect(manifest).not.toContain("${HOST}");
    expect(manifest).toContain("/word/index.html");
  });
});
