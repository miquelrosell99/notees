import { describe, expect, it } from "vitest";
import {
  deriveDisplayName,
  isBlock,
  isClass,
  isPage,
  plainTextExcerpt,
  SEEDED_SYSTEM_CLASSES,
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_EXTRA_CLASS_BINDINGS,
  SYSTEM_PAGE_UUIDS,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
} from "../src/index.js";
import type { ContentAst } from "@notees/protocol";

describe("system seeds (v1 port)", () => {
  it("has unique class UUIDs and icons for every class", () => {
    const names = Object.keys(SYSTEM_CLASS_UUIDS);
    const ids = Object.values(SYSTEM_CLASS_UUIDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const name of names) {
      expect(SYSTEM_CLASS_ICONS).toHaveProperty(name);
    }
  });

  it("every system class UUID lives in the reserved …-0001-… block", () => {
    for (const id of Object.values(SYSTEM_CLASS_UUIDS)) {
      expect(id).toMatch(/^00000000-0000-0000-0001-/);
    }
  });

  it("every property UUID lives in the reserved …-0000-…/…-0003-… blocks", () => {
    for (const id of Object.values(SYSTEM_PROPERTY_UUIDS)) {
      expect(id).toMatch(/^00000000-0000-0000-0000-|^00000000-0000-0000-0003-/);
    }
  });

  it("seeded classes and extends parents are all real system classes", () => {
    for (const name of SEEDED_SYSTEM_CLASSES) {
      expect(SYSTEM_CLASS_UUIDS).toHaveProperty(name);
    }
    for (const parents of Object.values(SYSTEM_CLASS_EXTENDS)) {
      for (const parent of parents ?? []) {
        expect(SYSTEM_CLASS_UUIDS).toHaveProperty(parent);
      }
    }
  });

  it("property specs bind to real classes; options carry unique ids", () => {
    for (const spec of Object.values(SYSTEM_PROPERTY_SPECS)) {
      expect(SYSTEM_CLASS_UUIDS).toHaveProperty(spec.bindTo);
      if (spec.options) {
        expect(new Set(spec.options.map((o) => o.id)).size).toBe(spec.options.length);
      }
    }
    for (const binding of SYSTEM_EXTRA_CLASS_BINDINGS) {
      expect(SYSTEM_PROPERTY_UUIDS).toHaveProperty(binding.property);
      expect(SYSTEM_CLASS_UUIDS).toHaveProperty(binding.bindTo);
    }
  });

  it("never reuses withdrawn ids (v1 locator …0018; linkedAuthors …0025)", () => {
    const allIds = [
      ...Object.values(SYSTEM_CLASS_UUIDS),
      ...Object.values(SYSTEM_PROPERTY_UUIDS),
      ...Object.values(SYSTEM_PAGE_UUIDS),
    ];
    expect(allIds).not.toContain("00000000-0000-0000-0000-000000000018");
    expect(allIds).not.toContain("00000000-0000-0000-0000-000000000025");
  });

  it("citations revision (2026-09-27, FINAL): source family + authorship seeds", () => {
    // New source subclasses: fixed ids in the next block, icons, extends, seeded.
    expect(SYSTEM_CLASS_UUIDS.song).toBe("00000000-0000-0000-0001-000000000036");
    expect(SYSTEM_CLASS_UUIDS.tv_series).toBe("00000000-0000-0000-0001-000000000037");
    expect(SYSTEM_CLASS_UUIDS.conference).toBe("00000000-0000-0000-0001-000000000038");
    for (const name of ["song", "tv_series", "conference"] as const) {
      expect(SYSTEM_CLASS_ICONS[name]).toMatch(/^mdi/);
      expect(SYSTEM_CLASS_EXTENDS[name]).toEqual(["source"]);
      expect(SEEDED_SYSTEM_CLASSES).toContain(name);
    }
    // FINAL authorship: `authors` is node-typed to agent nodes; the
    // text-authors + `linkedAuthors` experiment is withdrawn (…0025 never reused).
    expect(SYSTEM_PROPERTY_UUIDS.authors).toBe("00000000-0000-0000-0000-000000000012");
    expect(SYSTEM_PROPERTY_SPECS.authors).toEqual({
      type: "object",
      multi: true,
      bindTo: "source",
      targetClassFilter: ["agent"],
    });
    expect(SYSTEM_PROPERTY_UUIDS).not.toHaveProperty("linkedAuthors");
    expect(SYSTEM_PROPERTY_SPECS).not.toHaveProperty("linkedAuthors");
  });
});

describe("deriveDisplayName", () => {
  const page = { id: "p1", nodeType: "page" as const };

  it("stored name wins, truncated to the display budget", () => {
    expect(deriveDisplayName({ ...page, name: "  The Republic  " })).toBe("The Republic");
    expect(deriveDisplayName({ ...page, name: "x".repeat(200) })).toHaveLength(80);
  });

  it("falls back to the content excerpt for unnamed blocks", () => {
    const ast: ContentAst = [
      { type: "text", text: "Kuhn argues that paradigms" },
      { type: "typed_link", verb: "cites", text: "cites" },
      { type: "mention", targetNodeId: "0192a000-0000-7000-8000-000000000011", text: "Structure" },
    ];
    expect(deriveDisplayName({ id: "b1", nodeType: "block", contentAst: ast })).toBe(
      "Kuhn argues that paradigms cites Structure",
    );
  });

  it("prefers mention displayText, recurses quotes, skips structural tokens", () => {
    const ast: ContentAst = [
      { type: "quote", children: [{ type: "text", text: "quoted line" }] },
      { type: "mention", targetNodeId: "0192a000-0000-7000-8000-000000000011", text: "X", displayText: "the Republic" },
      { type: "embed_ref", nodeId: "0192a000-0000-7000-8000-000000000099" },
      { type: "whiteboard", layout: {} },
    ];
    expect(plainTextExcerpt(ast)).toBe("quoted line the Republic");
  });

  it("returns empty string when there is nothing to derive (caller falls back to id)", () => {
    expect(deriveDisplayName({ id: "b2", nodeType: "block", contentAst: [] })).toBe("");
    expect(deriveDisplayName({ ...page })).toBe("");
  });
});

describe("node type predicates", () => {
  it("distinguishes page / block / class", () => {
    expect(isPage({ nodeType: "page" })).toBe(true);
    expect(isBlock({ nodeType: "block" })).toBe(true);
    expect(isClass({ nodeType: "class" })).toBe(true);
    expect(isPage({ nodeType: "class" })).toBe(false);
  });
});

describe("date node display names", () => {
  const YEAR = "00000000-0000-0000-0001-000000000003";
  const MONTH = "00000000-0000-0000-0001-000000000004";
  const DAY = "00000000-0000-0000-0001-000000000005";

  it("formats raw date names per the slash-separated setting shape", () => {
    const base = { id: "n", nodeType: "page" as const };
    expect(deriveDisplayName({ ...base, name: "20290000", classIds: [YEAR] })).toBe("2029");
    expect(deriveDisplayName({ ...base, name: "20290600", classIds: [MONTH] })).toBe("2029/06");
    expect(deriveDisplayName({ ...base, name: "20290627", classIds: [DAY] })).toBe("2029/06/27");
  });

  it("leaves non-date nodes and malformed names untouched", () => {
    const base = { id: "n", nodeType: "page" as const };
    expect(deriveDisplayName({ ...base, name: "20290627" })).toBe("2029/06/27");
    expect(deriveDisplayName({ ...base, name: "Not a date", classIds: [DAY] })).toBe("Not a date");
  });
});
