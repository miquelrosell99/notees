/**
 * Logseq markdown grammar specs — the v1 client-side parser ported 1:1
 * (v1-archive: frontend/src/plugins/builtin/logseq_importer/utils/logseqMdParser.ts):
 * filename titles (`___`/`%2F` → `/`), page-level `key:: value` before the
 * first bullet, indent-stacked outline with any indent unit, continuation
 * lines appended trimStart, journal filenames `YYYY_MM_DD` range-checked,
 * wiki-link collection, pure-asset block extraction.
 */

import { describe, expect, it } from "vitest";

import {
  collectWikiLinks,
  countMdBlocks,
  extractAssetFilename,
  parseJournalDate,
  parseLogseqMd,
  parseLogseqMdFiles,
} from "../src/index.js";

describe("parseLogseqMd", () => {
  it("derives the title from the filename", () => {
    const page = parseLogseqMd("My Page.md", "- hello");
    expect(page.title).toBe("My Page");
  });

  it("decodes Logseq filename conventions", () => {
    expect(parseLogseqMd("Some___Nested%20Page.md", "- x").title).toBe(
      "Some/Nested Page",
    );
  });

  it("parses page-level properties before the first bullet and skips blank lines", () => {
    const md = [
      "title:: Custom Title",
      "",
      "tags:: alpha, beta",
      "",
      "- first block",
    ].join("\n");
    const page = parseLogseqMd("P.md", md);
    expect(page.properties).toEqual({ title: "Custom Title", tags: "alpha, beta" });
    expect(page.blocks).toHaveLength(1);
  });

  it("keeps block-level key:: value inline in the block content", () => {
    const page = parseLogseqMd("P.md", "- do something\n  priority:: high");
    expect(page.properties).toEqual({});
    expect(page.blocks[0]!.content).toBe("do something\npriority:: high");
  });

  it("nests blocks by indentation with any indent unit", () => {
    const md = [
      "- a",
      "  - a.1",
      "    - a.1.i",
      "  - a.2",
      "- b",
      "\t- b.1",
    ].join("\n");
    const page = parseLogseqMd("P.md", md);
    expect(page.blocks.map((b) => b.content)).toEqual(["a", "b"]);
    const [a, b] = page.blocks;
    expect(a!.children.map((c) => c.content)).toEqual(["a.1", "a.2"]);
    expect(a!.children[0]!.children[0]!.content).toBe("a.1.i");
    expect(b!.children[0]!.content).toBe("b.1");
  });

  it("appends non-bullet lines to the current block (blank lines included, per v1)", () => {
    const md = "- first\n  continued here\n\n  more\n- second";
    const page = parseLogseqMd("P.md", md);
    expect(page.blocks[0]!.content).toBe("first\ncontinued here\n\nmore");
    expect(page.blocks[1]!.content).toBe("second");
  });
});

describe("parseLogseqMdFiles", () => {
  it("parses several files at once", () => {
    const pages = parseLogseqMdFiles([
      { name: "A.md", content: "- one" },
      { name: "B.md", content: "- two" },
    ]);
    expect(pages.map((p) => p.title)).toEqual(["A", "B"]);
  });
});

describe("countMdBlocks", () => {
  it("counts nested blocks recursively", () => {
    const page = parseLogseqMd("P.md", "- a\n  - b\n  - c\n- d");
    expect(countMdBlocks(page.blocks)).toBe(4);
  });
});

describe("collectWikiLinks", () => {
  it("collects unique [[targets]] across the tree", () => {
    const page = parseLogseqMd("P.md", "- see [[X]] and [[Y]]\n  - also [[X]]");
    expect([...collectWikiLinks(page.blocks)].sort()).toEqual(["X", "Y"]);
  });
});

describe("extractAssetFilename", () => {
  it("extracts the filename from a pure-asset block", () => {
    expect(extractAssetFilename("![alt](../assets/photo%20one.png){:width 300}")).toBe(
      "photo%20one.png",
    );
  });

  it("returns null for mixed content", () => {
    expect(extractAssetFilename("look ![alt](../assets/p.png)")).toBeNull();
    expect(extractAssetFilename("plain text")).toBeNull();
  });
});

describe("parseJournalDate", () => {
  it("parses YYYY_MM_DD filenames", () => {
    expect(parseJournalDate("2025_06_04.md")).toBe("2025-06-04");
  });

  it("rejects out-of-range and non-journal names", () => {
    expect(parseJournalDate("2025_13_04.md")).toBeNull();
    expect(parseJournalDate("2025_06_40.md")).toBeNull();
    expect(parseJournalDate("Some Page.md")).toBeNull();
  });
});
