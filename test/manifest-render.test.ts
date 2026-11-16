import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { manifestFlavor, renderManifest, WORD_SERVE_DEFAULT_PORT } from "../scripts/copy-manifest.mjs";

const template = readFileSync("manifest.xml", "utf8");

describe("manifest render flavors", () => {
  it("default flavor keeps the /word/ base path the sync server serves", () => {
    const manifest = renderManifest(template, manifestFlavor([], {}));
    expect(manifest).toContain("https://localhost:8378/word/index.html");
    expect(manifest).toContain("https://localhost:8378/word/assets/icon-32.png");
    expect(manifest).not.toContain("${");
  });

  it("localhost flavor targets the notees word serve root layout", () => {
    const manifest = renderManifest(template, manifestFlavor(["localhost"], {}));
    expect(manifest).toContain(`http://localhost:${WORD_SERVE_DEFAULT_PORT}/index.html`);
    expect(manifest).toContain(`http://localhost:${WORD_SERVE_DEFAULT_PORT}/assets/icon-80.png`);
    expect(manifest).not.toContain("/word/");
    expect(manifest).not.toContain("${");
  });

  it("env vars override either flavor", () => {
    const manifest = renderManifest(
      template,
      manifestFlavor(["localhost"], { NOTEES_WORD_HOST: "http://localhost:9999", NOTEES_WORD_BASE_PATH: "/pane" }),
    );
    expect(manifest).toContain("http://localhost:9999/pane/index.html");
  });

  it("an unresolved placeholder fails the render loudly", () => {
    expect(() => renderManifest("stays ${UNRESOLVED} forever", { host: "http://localhost:8471", basePath: "" })).toThrow(
      /placeholder/,
    );
  });
});
