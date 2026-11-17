import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT } from "../src/exit-codes.js";
import { resolveWordDistDir, wordCacheDir } from "../src/word/paths.js";

describe("wordCacheDir", () => {
  it("NOTEES_WORD_CACHE_DIR overrides everything", () => {
    expect(wordCacheDir({ NOTEES_WORD_CACHE_DIR: "/tmp/elsewhere" }, "linux")).toBe("/tmp/elsewhere");
  });

  it("posix: XDG_CACHE_HOME, else ~/.cache", () => {
    expect(wordCacheDir({ XDG_CACHE_HOME: "/tmp/xdg" }, "linux")).toBe(join("/tmp/xdg", "notees", "word"));
    const home = wordCacheDir({}, "linux");
    expect(home.endsWith(join(".cache", "notees", "word"))).toBe(true);
  });

  it("win32: LOCALAPPDATA, else the homedir fallback (Word runs on Windows)", () => {
    const localAppData = "C:\\Users\\someone\\AppData\\Local";
    // path.join uses the host separator even for a Windows-shaped input;
    // on a real Windows host this is "…\Local\notees\word".
    expect(wordCacheDir({ LOCALAPPDATA: localAppData }, "win32")).toBe(join(localAppData, "notees", "word"));
    expect(wordCacheDir({}, "win32").endsWith(join("AppData", "Local", "notees", "word"))).toBe(true);
  });
});

describe("resolveWordDistDir", () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "notees-word-dist-"));
    roots.push(root);
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("NOTEES_WORD_DIST wins", () => {
    expect(resolveWordDistDir({ NOTEES_WORD_DIST: "/tmp/dist" }, "/nonexistent")).toBe("/tmp/dist");
  });

  it("walks up from a nested start dir to the committed snapshot", () => {
    const root = makeRoot();
    mkdirSync(join(root, "word-snapshot", "dist"), { recursive: true });
    const nested = join(root, "src", "word");
    mkdirSync(nested, { recursive: true });
    expect(resolveWordDistDir({}, nested)).toBe(join(root, "word-snapshot", "dist"));
  });

  it("walks up from a nested start dir to a built in-tree add-in dist", () => {
    const root = makeRoot();
    mkdirSync(join(root, "clients", "word", "dist"), { recursive: true });
    const nested = join(root, "clients", "cli", "src", "word");
    mkdirSync(nested, { recursive: true });
    expect(resolveWordDistDir({}, nested)).toBe(join(root, "clients", "word", "dist"));
  });

  it("a usage error names the way out when nothing is found", () => {
    const root = makeRoot();
    try {
      resolveWordDistDir({}, root);
      expect.unreachable("expected resolution to fail");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(EXIT.usage);
      expect((error as Error).message).toContain("pnpm build:localhost");
    }
  });

  it("refuses an empty override", () => {
    const root = makeRoot();
    writeFileSync(join(root, "marker"), "");
    try {
      resolveWordDistDir({ NOTEES_WORD_DIST: "" }, root);
      expect.unreachable("expected resolution to fail");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(EXIT.usage);
    }
  });
});
