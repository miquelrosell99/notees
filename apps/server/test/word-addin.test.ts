import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
let addinDir: string;
afterEach(async () => {
  if (server !== null) { await closeTestServer(server); server = null; }
  if (addinDir !== undefined) rmSync(addinDir, { recursive: true, force: true });
});

function stageAddin() {
  addinDir = mkdtempSync(join(tmpdir(), "notees-addin-"));
  writeFileSync(join(addinDir, "manifest.xml"), "<manifest>ok</manifest>");
  mkdirSync(join(addinDir, "assets"));
  writeFileSync(join(addinDir, "assets", "taskpane.js"), "console.log(1);");
}

describe("GET /word/ — add-in statics", () => {
  it("serves files without auth and maps content types", async () => {
    stageAddin();
    server = await makeTestServer({ wordAddinDir: addinDir });
    const manifest = await server.app.inject({ method: "GET", url: "/word/manifest.xml" });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["content-type"]).toContain("application/xml");
    expect(manifest.body).toBe("<manifest>ok</manifest>");
    const js = await server.app.inject({ method: "GET", url: "/word/assets/taskpane.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
  });

  it("404s when unconfigured or missing, and refuses traversal", async () => {
    server = await makeTestServer(); // no wordAddinDir
    const off = await server.app.inject({ method: "GET", url: "/word/manifest.xml" });
    expect(off.statusCode).toBe(404);
    await closeTestServer(server);
    stageAddin();
    server = await makeTestServer({ wordAddinDir: addinDir });
    expect((await server.app.inject({ method: "GET", url: "/word/nope.js" })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: "/word/../secret" })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: "/word/%2e%2e/secret" })).statusCode).toBe(404);
  });

  it("404s a symlink escaping the dir and never serves the outside file", async () => {
    stageAddin();
    const outsideDir = mkdtempSync(join(tmpdir(), "notees-addin-out-"));
    writeFileSync(join(outsideDir, "secret.txt"), "top-secret-outside-content");
    symlinkSync(join(outsideDir, "secret.txt"), join(addinDir, "escape.txt"));
    server = await makeTestServer({ wordAddinDir: addinDir });
    const res = await server.app.inject({ method: "GET", url: "/word/escape.txt" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("top-secret-outside-content");
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
