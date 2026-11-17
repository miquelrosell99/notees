import { describe, expect, it } from "vitest";

import { EXIT } from "../src/exit-codes.js";
import { resolveWordServeConfig } from "../src/word/config.js";
import { renderWordManifest } from "../src/word/manifest.js";

describe("resolveWordServeConfig", () => {
  it("defaults to port 8471 on 127.0.0.1, no restart", () => {
    expect(resolveWordServeConfig({}, {})).toEqual({ host: "127.0.0.1", port: 8471, restart: false });
  });

  it("flag beats env beats default", () => {
    expect(resolveWordServeConfig({ port: "9000" }, { NOTEES_WORD_PORT: "9100" }).port).toBe(9000);
    expect(resolveWordServeConfig({}, { NOTEES_WORD_PORT: "9100" }).port).toBe(9100);
  });

  it("0 is allowed (OS-assigned, the test path)", () => {
    expect(resolveWordServeConfig({ port: "0" }, {}).port).toBe(0);
  });

  it("rejects non-integer and out-of-range ports with a usage error", () => {
    for (const bad of ["abc", "1.5", "70000", "-2"]) {
      try {
        resolveWordServeConfig({ port: bad }, {});
        expect.unreachable(`expected "${bad}" to be rejected`);
      } catch (error) {
        expect((error as { exitCode: number }).exitCode).toBe(EXIT.usage);
      }
    }
  });

  it("restart follows the flag", () => {
    expect(resolveWordServeConfig({ restart: true }, {}).restart).toBe(true);
  });
});

describe("renderWordManifest", () => {
  const template = [
    '<IconUrl DefaultValue="${HOST}${BASE_PATH}/assets/icon-32.png"/>',
    '<SourceLocation DefaultValue="${HOST}${BASE_PATH}/index.html"/>',
  ].join("\n");

  it("renders the localhost origin and an empty base path for the port", () => {
    const manifest = renderWordManifest(template, 8471);
    expect(manifest).toContain("http://localhost:8471/index.html");
    expect(manifest).toContain("http://localhost:8471/assets/icon-32.png");
    expect(manifest).not.toContain("${");
  });

  it("renders the actual OS-assigned port", () => {
    expect(renderWordManifest(template, 51234)).toContain("http://localhost:51234/index.html");
  });

  it("an unresolved placeholder is a domain error, not silent garbage", () => {
    try {
      renderWordManifest("stays ${UNRESOLVED} forever", 8471);
      expect.unreachable("expected the render to fail");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(EXIT.domain);
    }
  });
});
