import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLASS_ICON,
  DEFAULT_PAGE_ICON,
  defaultIconFor,
  deriveDisplayName,
  isClassNode,
  plainTextExcerpt,
  rendersAsInlineBlock,
  rendersWithDocumentChrome,
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

  it("property specs bind to real classes (when bound — PG10 made bindTo optional for the global alias); options carry unique ids", () => {
    for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
      // PG10 (2026-10-04): bindTo-less specs seed the schema at global scope
      // with no class binding (the alias property — "page" is not a class).
      if (spec.bindTo !== undefined) {
        expect(SYSTEM_CLASS_UUIDS).toHaveProperty(spec.bindTo);
      }
      expect(SYSTEM_PROPERTY_UUIDS).toHaveProperty(name);
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

  it("templates seed (§34.25 T2): has-template reserved, seeded, targets the template class", () => {
    // Next free id in the general block (…0018 withdrawn, …0025 withdrawn —
    // never reused); the domain-wide block rule above pins the prefix.
    expect(SYSTEM_PROPERTY_UUIDS.hasTemplate).toBe("00000000-0000-0000-0000-000000000026");
    // D1: the relation lives on the class node, multi, targeting templates.
    expect(SYSTEM_PROPERTY_SPECS.hasTemplate).toEqual({
      type: "object",
      multi: true,
      bindTo: "class",
      targetClassFilter: ["template"],
    });
  });

  it("templates provenance seed (§34.25 T3, D1 amendment 2026-10-03): generated-from is instance-side, never class-bound", () => {
    expect(SYSTEM_PROPERTY_UUIDS.generatedFrom).toBe("00000000-0000-0000-0000-000000000027");
    // Instance metadata: no SYSTEM_PROPERTY_SPECS entry (a spec would seed a
    // class binding — the amendment forbids one); the web client authors the
    // schema idempotently (ensureGeneratedFromProperty).
    expect(SYSTEM_PROPERTY_SPECS).not.toHaveProperty("generatedFrom");
    for (const binding of SYSTEM_EXTRA_CLASS_BINDINGS) {
      expect(binding.property).not.toBe("generatedFrom");
    }
  });

  it("meeting family seeds (§34.36, owner ruling 2026-10-04: plain seeds — zero wire cost)", () => {
    // The register's reserved class id (append-only rule; conference …038
    // stays the previous tail). Standalone — no SYSTEM_CLASS_EXTENDS entry.
    expect(SYSTEM_CLASS_UUIDS.meeting).toBe("00000000-0000-0000-0001-000000000039");
    expect(SYSTEM_CLASS_ICONS.meeting).toMatch(/^mdi/);
    expect(SYSTEM_CLASS_EXTENDS).not.toHaveProperty("meeting");
    expect(SEEDED_SYSTEM_CLASSES).toContain("meeting");
    // The family continues the workflow-properties block (task family
    // …001–…006; the pinned block rule above covers …0003-…).
    expect(SYSTEM_PROPERTY_UUIDS.meetingDate).toBe("00000000-0000-0000-0003-000000000007");
    expect(SYSTEM_PROPERTY_UUIDS.location).toBe("00000000-0000-0000-0003-000000000008");
    expect(SYSTEM_PROPERTY_UUIDS.agenda).toBe("00000000-0000-0000-0003-000000000009");
    // M2 whole-day law: the date binding is date-typed — there is no
    // clock-time type anywhere in the spec union.
    expect(SYSTEM_PROPERTY_SPECS.meetingDate).toEqual({ type: "date", bindTo: "meeting" });
    expect(SYSTEM_PROPERTY_SPECS.location).toEqual({ type: "text", bindTo: "meeting" });
    expect(SYSTEM_PROPERTY_SPECS.agenda).toEqual({ type: "text", bindTo: "meeting" });
  });
});

describe("deriveDisplayName", () => {
  // A parentless non-class node: document chrome, title-is-content.
  const page = { id: "p1", isClass: false, presentAsMain: true, parentId: null };

  it("content title is trimmed and truncated to the display budget", () => {
    expect(
      deriveDisplayName({ ...page, contentAst: [{ type: "text", text: "  The Republic  " }] }),
    ).toBe("The Republic");
    expect(
      deriveDisplayName({ ...page, contentAst: [{ type: "text", text: "x".repeat(200) }] }),
    ).toHaveLength(80);
  });

  it("falls back to the content excerpt for unnamed blocks", () => {
    const ast: ContentAst = [
      { type: "text", text: "Kuhn argues that paradigms" },
      { type: "typed_link", verb: "cites", text: "cites" },
      { type: "mention", targetNodeId: "0192a000-0000-7000-8000-000000000011", text: "Structure" },
    ];
    expect(
      deriveDisplayName({ id: "b1", isClass: false, presentAsMain: false, parentId: "p1", contentAst: ast }),
    ).toBe("Kuhn argues that paradigms cites Structure");
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
    expect(
      deriveDisplayName({ id: "b2", isClass: false, presentAsMain: false, parentId: "p1", contentAst: [] }),
    ).toBe("");
    expect(deriveDisplayName({ ...page })).toBe("");
  });
});

describe("render-state cascade predicates (Revision 11)", () => {
  it("isClassNode reads the identity bit (store 0/1 rows included)", () => {
    expect(isClassNode({ isClass: true })).toBe(true);
    expect(isClassNode({ isClass: 1 })).toBe(true);
    expect(isClassNode({ isClass: false })).toBe(false);
    expect(isClassNode({})).toBe(false);
  });

  it("rendersWithDocumentChrome: classes never; parentless always; parented by the bit", () => {
    expect(rendersWithDocumentChrome({ isClass: true, parentId: null })).toBe(false);
    expect(rendersWithDocumentChrome({ isClass: true, parentId: "p" })).toBe(false);
    // Parentless: document chrome regardless of the bit (second branch).
    expect(rendersWithDocumentChrome({ isClass: false, parentId: null })).toBe(true);
    expect(rendersWithDocumentChrome({ isClass: false, parentId: null, presentAsMain: false })).toBe(true);
    // Parented: the bit decides (third branch).
    expect(rendersWithDocumentChrome({ isClass: false, parentId: "p", presentAsMain: true })).toBe(true);
    expect(rendersWithDocumentChrome({ isClass: false, parentId: "p", presentAsMain: false })).toBe(false);
  });

  it("rendersAsInlineBlock: only parented non-class nodes with the bit unset", () => {
    expect(rendersAsInlineBlock({ isClass: false, parentId: "p", presentAsMain: false })).toBe(true);
    expect(rendersAsInlineBlock({ isClass: false, parentId: "p" })).toBe(true);
    expect(rendersAsInlineBlock({ isClass: false, parentId: "p", presentAsMain: true })).toBe(false);
    // Parentless nodes are documents, never inline blocks.
    expect(rendersAsInlineBlock({ isClass: false, parentId: null })).toBe(false);
    // Classes render ClassView — never inline blocks.
    expect(rendersAsInlineBlock({ isClass: true, parentId: "p" })).toBe(false);
  });
});

describe("defaultIconFor (display-time icon defaults)", () => {
  it("class nodes get the class glyph", () => {
    expect(defaultIconFor({ isClass: true, parentId: null, presentAsMain: false })).toBe(
      DEFAULT_CLASS_ICON,
    );
  });

  it("parentless nodes get the page glyph (second cascade branch)", () => {
    expect(defaultIconFor({ isClass: false, parentId: null, presentAsMain: false })).toBe(
      DEFAULT_PAGE_ICON,
    );
  });

  it("parented main-presenting nodes get the page glyph (third cascade branch)", () => {
    expect(defaultIconFor({ isClass: false, parentId: "p", presentAsMain: true })).toBe(
      DEFAULT_PAGE_ICON,
    );
  });

  it("inline blocks get none — their chrome is the bullet dot", () => {
    expect(defaultIconFor({ isClass: false, parentId: "p", presentAsMain: false })).toBeNull();
  });

  it("defaults are MDI kebab names (the web Icon resolver form)", () => {
    expect(DEFAULT_CLASS_ICON).toMatch(/^mdi-[a-z0-9-]+$/);
    expect(DEFAULT_PAGE_ICON).toMatch(/^mdi-[a-z0-9-]+$/);
  });
});

describe("date node display names", () => {
  const YEAR = "00000000-0000-0000-0001-000000000003";
  const MONTH = "00000000-0000-0000-0001-000000000004";
  const DAY = "00000000-0000-0000-0001-000000000005";

  it("formats raw date content labels per the slash-separated setting shape", () => {
    const base = { id: "n", isClass: false, presentAsMain: true, parentId: null };
    const text = (t: string) => ({ type: "text" as const, text: t });
    expect(deriveDisplayName({ ...base, contentAst: [text("20290000")], classIds: [YEAR] })).toBe("2029");
    expect(deriveDisplayName({ ...base, contentAst: [text("20290600")], classIds: [MONTH] })).toBe("2029/06");
    expect(deriveDisplayName({ ...base, contentAst: [text("20290627")], classIds: [DAY] })).toBe("2029/06/27");
  });

  it("treats a uuid-stored name as unnamed (legacy untitled pages)", () => {
    const base = { id: "n", isClass: false, presentAsMain: true, parentId: null };
    expect(
      deriveDisplayName({
        ...base,
        name: "67ceb334-2e21-40e8-99ad-d6a069f497ef",
        contentAst: [{ type: "text", text: "Real title in content" }],
      }),
    ).toBe("Real title in content");
  });

  it("leaves non-date content untouched", () => {
    const base = { id: "n", isClass: false, presentAsMain: true, parentId: null };
    const text = (t: string) => ({ type: "text" as const, text: t });
    expect(deriveDisplayName({ ...base, contentAst: [text("Not a date")], classIds: [DAY] })).toBe(
      "Not a date",
    );
  });
});
