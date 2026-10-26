/**
 * Frontmatter parser specs — the v1 `/import/markdown` grammar ported
 * (v1-archive: app/features/import_/frontmatter_parser.py): `---` and `+++`
 * delimiters (both parsed as YAML), keys normalized to lower case, invalid
 * YAML fails loud, non-mapping YAML yields empty metadata, whitespace after
 * the closing delimiter stripped (the v1 regex's `\s*` — port-faithful).
 */

import { describe, expect, it } from "vitest";

import { normalizeMetadata, parseFrontmatter } from "../src/index.js";

describe("parseFrontmatter", () => {
  it("returns empty metadata and the untouched body when no frontmatter", () => {
    const { metadata, body } = parseFrontmatter("# Hello\n\nSome body.\n");
    expect(metadata).toEqual({});
    expect(body).toBe("# Hello\n\nSome body.\n");
  });

  it("parses a --- YAML block and strips it from the body", () => {
    const doc = [
      "---",
      "title: My Page",
      "tags:",
      "  - alpha",
      "  - beta",
      "---",
      "",
      "Body here.",
    ].join("\n");
    const { metadata, body } = parseFrontmatter(doc);
    expect(metadata).toEqual({ title: "My Page", tags: ["alpha", "beta"] });
    expect(body).toBe("Body here.");
  });

  it("accepts +++ as a delimiter, parsed as YAML", () => {
    const doc = ["+++", "title: Plus Doc", "+++", "Body."].join("\n");
    const { metadata, body } = parseFrontmatter(doc);
    expect(metadata).toEqual({ title: "Plus Doc" });
    expect(body).toBe("Body.");
  });

  it("lower-cases keys via normalizeMetadata", () => {
    expect(normalizeMetadata({ Title: "x", UUID: "u", MiXeD: 1 })).toEqual({
      title: "x",
      uuid: "u",
      mixed: 1,
    });
  });

  it("fails loud on invalid YAML", () => {
    const doc = ["---", "title: [unclosed", "---", "Body."].join("\n");
    expect(() => parseFrontmatter(doc)).toThrow(/Invalid frontmatter YAML/);
  });

  it("treats non-mapping YAML as empty metadata", () => {
    const doc = ["---", "- just", "- a", "- list", "---", "Body."].join("\n");
    const { metadata, body } = parseFrontmatter(doc);
    expect(metadata).toEqual({});
    expect(body).toBe("Body.");
  });

  it("strips blank lines and indentation after the closing delimiter (v1 regex semantics)", () => {
    const doc = "---\ntitle: T\n---\n\n\n  indented body\n";
    const { body } = parseFrontmatter(doc);
    expect(body).toBe("indented body\n");
  });
});
