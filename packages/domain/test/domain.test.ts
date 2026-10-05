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
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_EXTRA_CLASS_BINDINGS,
  SYSTEM_PAGE_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  systemClassAncestors,
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

  it("never reuses withdrawn ids (v1 locator …0018; linkedAuthors …0025; cover class …0042)", () => {
    const allIds = [
      ...Object.values(SYSTEM_CLASS_UUIDS),
      ...Object.values(SYSTEM_PROPERTY_UUIDS),
      ...Object.values(SYSTEM_PAGE_UUIDS),
    ];
    expect(allIds).not.toContain("00000000-0000-0000-0000-000000000018");
    expect(allIds).not.toContain("00000000-0000-0000-0000-000000000025");
    // §34.74 (owner 2026-10-04): the cover system class duplicated the cover
    // property — covers are plain asset-classed nodes. Minted and withdrawn
    // the same day; never reuse.
    expect(allIds).not.toContain("00000000-0000-0000-0001-000000000042");
    // §34.81 (owner 2026-10-05): the scratchpad page is withdrawn — not
    // wanted. No longer seeded (SYSTEM_PAGE_UUIDS carries inbox only); the
    // id lives on as LEGACY_SCRATCHPAD_PAGE_ID for the zip exclusion, never
    // to be re-seeded.
    expect(allIds).not.toContain("00000000-0000-0000-0002-000000000001");
    expect(SYSTEM_PAGE_UUIDS).not.toHaveProperty("scratchpad");
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

  it("node aliases (issue #7, owner 2026-10-05): aliasOf is the next general-block id, single-value node-typed, global, coexisting with the text alias", () => {
    // …0029 continues the general block after the §34.32 text alias (…0028);
    // the domain-wide block/prefix rules above pin the shape.
    expect(SYSTEM_PROPERTY_UUIDS.aliasOf).toBe("00000000-0000-0000-0000-000000000029");
    // Single-value node-typed: NO multi, NO bindTo, NO targetClassFilter —
    // both the carrier and the target are "pages", and page is a render
    // state, not a class, so no binding/filter can express it (client-side
    // enforcement; SCHEMA.md "Node aliases").
    expect(SYSTEM_PROPERTY_SPECS.aliasOf).toEqual({ type: "object" });
    expect(SYSTEM_PROPERTY_DISPLAY_NAMES.aliasOf).toBe("Alias of");
    for (const binding of SYSTEM_EXTRA_CLASS_BINDINGS) {
      expect(binding.property).not.toBe("aliasOf");
    }
    // Coexistence with the §34.32 text alias — both stay seeded.
    expect(SYSTEM_PROPERTY_UUIDS.alias).toBe("00000000-0000-0000-0000-000000000028");
    expect(SYSTEM_PROPERTY_SPECS.alias).toEqual({ type: "text", multi: true });
  });

  it("meeting/event family seeds (§34.36 + owner reshape directive 2026-10-04: plain seeds — zero wire cost)", () => {
    // The register's reserved class ids (append-only rule): meeting …039
    // (first slice), then `event` …040 — the calendar family root seeded by
    // the owner's reshape directive.
    expect(SYSTEM_CLASS_UUIDS.meeting).toBe("00000000-0000-0000-0001-000000000039");
    expect(SYSTEM_CLASS_UUIDS.event).toBe("00000000-0000-0000-0001-000000000040");
    expect(SYSTEM_CLASS_ICONS.meeting).toMatch(/^mdi/);
    expect(SYSTEM_CLASS_ICONS.event).toMatch(/^mdi/);
    expect(SEEDED_SYSTEM_CLASSES).toContain("meeting");
    expect(SEEDED_SYSTEM_CLASSES).toContain("event");
    // The reshape: meeting IS-A event via the seeded extends edge.
    expect(SYSTEM_CLASS_EXTENDS.meeting).toEqual(["event"]);
    expect(SYSTEM_CLASS_EXTENDS.event).toBeUndefined();
    // The families continue the workflow-properties block (task family
    // …001–…006; meeting …007–…009; event …010 — the pinned block rule
    // above covers …0003-…).
    expect(SYSTEM_PROPERTY_UUIDS.meetingDate).toBe("00000000-0000-0000-0003-000000000007");
    expect(SYSTEM_PROPERTY_UUIDS.location).toBe("00000000-0000-0000-0003-000000000008");
    expect(SYSTEM_PROPERTY_UUIDS.agenda).toBe("00000000-0000-0000-0003-000000000009");
    expect(SYSTEM_PROPERTY_UUIDS.eventDate).toBe("00000000-0000-0000-0003-000000000010");
    // M2 whole-day law: the date bindings are date-typed — there is no
    // clock-time type anywhere in the spec union.
    expect(SYSTEM_PROPERTY_SPECS.meetingDate).toEqual({ type: "date", bindTo: "meeting" });
    expect(SYSTEM_PROPERTY_SPECS.location).toEqual({ type: "text", bindTo: "meeting" });
    expect(SYSTEM_PROPERTY_SPECS.agenda).toEqual({ type: "text", bindTo: "meeting" });
    expect(SYSTEM_PROPERTY_SPECS.eventDate).toEqual({ type: "date", bindTo: "event" });
  });

  it("birthday family seeds (§34.36.3, owner directive 2026-10-04: birthday extends event, for persons)", () => {
    // The next reserved class id after event …040; person-typed family, NO
    // birthdayDate (the date rides eventDate through the extends chain).
    expect(SYSTEM_CLASS_UUIDS.birthday).toBe("00000000-0000-0000-0001-000000000041");
    expect(SYSTEM_CLASS_ICONS.birthday).toMatch(/^mdi/);
    expect(SEEDED_SYSTEM_CLASSES).toContain("birthday");
    expect(SYSTEM_CLASS_EXTENDS.birthday).toEqual(["event"]);
    // The family's only own property: the person the birthday is for —
    // object-typed, filter rooted at person (extends-aware validation accepts
    // person + person subclasses; an organization is NOT a birthday target).
    expect(SYSTEM_PROPERTY_UUIDS.birthdayPerson).toBe("00000000-0000-0000-0003-000000000011");
    expect(SYSTEM_PROPERTY_SPECS.birthdayPerson).toEqual({
      type: "object",
      bindTo: "birthday",
      targetClassFilter: ["person"],
    });
    expect(SYSTEM_PROPERTY_UUIDS).not.toHaveProperty("birthdayDate");
    expect(SYSTEM_PROPERTY_SPECS).not.toHaveProperty("birthdayDate");
    // The chip-eligibility row: eventDate re-bound on birthday (mirrors the
    // seed; there must be exactly one such extra binding).
    const extra = SYSTEM_EXTRA_CLASS_BINDINGS.filter(
      (binding) => binding.property === "eventDate" && binding.bindTo === "birthday",
    );
    expect(extra).toEqual([{ property: "eventDate", bindTo: "birthday", sequence: 0 }]);
  });

  it("cover is not bound to source anywhere in the seed manifest (owner ruling 2026-10-05: a cover makes no sense on sources)", () => {
    for (const binding of SYSTEM_EXTRA_CLASS_BINDINGS) {
      expect(binding.property === "cover" && binding.bindTo === "source").toBe(false);
    }
  });

  it("system display names: normal wording for every system class and property (owner 2026-10-05)", async () => {
    // Completeness: exactly one display name per seed key — the manifest
    // must never lag a new seed.
    expect(Object.keys(SYSTEM_CLASS_DISPLAY_NAMES).sort()).toEqual(
      Object.keys(SYSTEM_CLASS_UUIDS).sort(),
    );
    expect(Object.keys(SYSTEM_PROPERTY_DISPLAY_NAMES).sort()).toEqual(
      Object.keys(SYSTEM_PROPERTY_UUIDS).sort(),
    );
    const classNames = Object.values(SYSTEM_CLASS_DISPLAY_NAMES);
    const propertyNames = Object.values(SYSTEM_PROPERTY_DISPLAY_NAMES);
    // Display names are unique (no two seeds collapse into one label).
    expect(new Set(classNames).size).toBe(classNames.length);
    expect(new Set(propertyNames).size).toBe(propertyNames.length);
    for (const label of [...classNames, ...propertyNames]) {
      expect(label.length).toBeGreaterThan(0);
      // Normal wording: no camelCase runs, no snake_case, no kebab-case.
      expect(label).not.toMatch(/[a-z][A-Z]/);
      expect(label).not.toMatch(/[_-]/);
    }
    // The owner's canonical examples.
    expect(SYSTEM_CLASS_DISPLAY_NAMES.tv_series).toBe("TV series");
    expect(SYSTEM_PROPERTY_DISPLAY_NAMES.publicationDate).toBe("Publication date");
    // The task-family entries mirror the applier-side TASK_FAMILY_SEED names.
    const { TASK_FAMILY_SEED } = await import("../src/index.js");
    for (const entry of TASK_FAMILY_SEED) {
      expect(SYSTEM_PROPERTY_DISPLAY_NAMES[entry.property]).toBe(entry.name);
    }
  });

  it("systemClassAncestors encodes the Features-tab gating semantics (§34.36 reshape + §34.36.3 birthday)", () => {
    // Disabling event disables meeting WITH it (child sees the ancestor)…
    expect(systemClassAncestors("meeting").has("event")).toBe(true);
    // …and birthday disables with event the same way (sibling child)…
    expect(systemClassAncestors("birthday").has("event")).toBe(true);
    // …while disabling a child alone leaves event live (no reverse edge), and
    // the children don't gate each other.
    expect(systemClassAncestors("event").size).toBe(0);
    expect(systemClassAncestors("meeting").has("birthday")).toBe(false);
    expect(systemClassAncestors("birthday").has("meeting")).toBe(false);
    // Multi-hop + sibling families unaffected.
    expect(systemClassAncestors("book").has("source")).toBe(true);
    expect(systemClassAncestors("meeting").has("source")).toBe(false);
    expect(systemClassAncestors("meeting").has("task")).toBe(false);
    expect(systemClassAncestors("task").size).toBe(0);
    // Persons stay always-on: the birthday family's person-typed filter does
    // NOT make person part of the event hierarchy (no person gating).
    expect(systemClassAncestors("person").has("event")).toBe(false);
    expect(systemClassAncestors("birthday").has("person")).toBe(false);
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

describe("workspace feature map (§34.35, reshaped §34.55)", () => {
  it("the five core families map to their seeded base classes", async () => {
    const { WORKSPACE_FEATURE_MAP, managedClassIds, featureForManagedClass } = await import(
      "../src/index.js"
    );
    expect(WORKSPACE_FEATURE_MAP.tasks.baseClass).toBe("task");
    expect(WORKSPACE_FEATURE_MAP.events.baseClass).toBe("event");
    expect(WORKSPACE_FEATURE_MAP.meetings.baseClass).toBe("meeting");
    expect(WORKSPACE_FEATURE_MAP.sources.baseClass).toBe("source");
    expect(WORKSPACE_FEATURE_MAP.persons.baseClass).toBe("person");
    for (const spec of Object.values(WORKSPACE_FEATURE_MAP)) {
      expect(spec.powers.length).toBeGreaterThan(10);
      expect(SYSTEM_CLASS_UUIDS).toHaveProperty(spec.baseClass);
    }
    // F4 routing resolves the five BASE ids and nothing else.
    expect(featureForManagedClass(SYSTEM_CLASS_UUIDS.task)).toBe("tasks");
    expect(featureForManagedClass(SYSTEM_CLASS_UUIDS.event)).toBe("events");
    expect(featureForManagedClass(SYSTEM_CLASS_UUIDS.meeting)).toBe("meetings");
    expect(featureForManagedClass(SYSTEM_CLASS_UUIDS.source)).toBe("sources");
    expect(featureForManagedClass(SYSTEM_CLASS_UUIDS.person)).toBe("persons");
    // Family children do NOT route (plain delete semantics stay).
    expect(featureForManagedClass(SYSTEM_CLASS_UUIDS.book)).toBeNull();
    expect(featureForManagedClass(SYSTEM_CLASS_UUIDS.birthday)).toBeNull();
    expect(managedClassIds("tasks")).toEqual([SYSTEM_CLASS_UUIDS.task]);
  });

  it("the family set cascades through extends-children (events → meeting + birthday; sources → the 9-strong family)", async () => {
    const { familyClassNames, managedClassIds } = await import("../src/index.js");
    expect(familyClassNames("events")).toEqual(["event", "birthday", "meeting"]);
    expect(familyClassNames("meetings")).toEqual(["meeting"]);
    expect(familyClassNames("sources")).toEqual([
      "source",
      "article",
      "book",
      "conference",
      "document",
      "movie",
      "paper",
      "song",
      "thesis",
      "tv_series",
    ]);
    expect(familyClassNames("persons")).toEqual(["person"]);
    expect(managedClassIds("events")).toHaveLength(3);
    expect(managedClassIds("sources")).toHaveLength(10);
  });

  it("chrome gating: own feature + managed ancestors (meeting ← meetings AND events; birthday ← events only)", async () => {
    const { gatingFeaturesForClass } = await import("../src/index.js");
    expect(gatingFeaturesForClass("task")).toEqual(["tasks"]);
    expect(gatingFeaturesForClass("meeting")).toEqual(["meetings", "events"]);
    expect(gatingFeaturesForClass("birthday")).toEqual(["events"]);
    expect(gatingFeaturesForClass("event")).toEqual(["events"]);
    expect(gatingFeaturesForClass("book")).toEqual(["sources"]);
    expect(gatingFeaturesForClass("conference")).toEqual(["sources"]);
    expect(gatingFeaturesForClass("person")).toEqual(["persons"]);
    // Always-on / unmanaged classes gate on nothing.
    expect(gatingFeaturesForClass("day")).toEqual([]);
    expect(gatingFeaturesForClass("agent")).toEqual([]);
    expect(gatingFeaturesForClass("organization")).toEqual([]);
    expect(gatingFeaturesForClass("collection")).toEqual([]);
    expect(gatingFeaturesForClass("whiteboard")).toEqual([]);
  });

  it("F1: always-on classes are never managed; the base system + the dropped features' classes stay always-on", async () => {
    const {
      ALWAYS_ON_SYSTEM_CLASSES,
      WORKSPACE_FEATURE_MAP,
      isAlwaysOnSystemClass,
    } = await import("../src/index.js");
    const bases = new Set(Object.values(WORKSPACE_FEATURE_MAP).map((spec) => spec.baseClass));
    for (const name of ALWAYS_ON_SYSTEM_CLASSES) {
      expect(bases.has(name as never), `always-on ${name} must not be a family base`).toBe(false);
      expect(isAlwaysOnSystemClass(name)).toBe(true);
    }
    // Journals + assets stay always-on base system; the dropped features'
    // classes (highlight/weblink/collection/agent/organization) are plain
    // vocabulary now.
    for (const name of [
      "year",
      "month",
      "day",
      "asset",
      "highlight",
      "weblink",
      "collection",
      "agent",
      "organization",
    ] as const) {
      expect(ALWAYS_ON_SYSTEM_CLASSES).toContain(name);
    }
    // whiteboard (class/token duality) stays always-on; the family bases don't.
    expect(ALWAYS_ON_SYSTEM_CLASSES).toContain("whiteboard");
    for (const name of ["task", "event", "meeting", "source", "person", "book", "birthday"] as const) {
      expect(ALWAYS_ON_SYSTEM_CLASSES).not.toContain(name);
    }
  });

  it("task-family seed-ensure manifest: six schemas at fixed ids with deterministic option ids", async () => {
    const {
      TASK_FAMILY_SEED,
      TASK_STATUS_OPTION_UUIDS,
      TASK_PRIORITY_OPTION_UUIDS,
    } = await import("../src/index.js");
    expect(TASK_FAMILY_SEED.map((entry) => entry.property)).toEqual([
      "taskStatus",
      "taskScheduled",
      "taskDeadline",
      "taskPriority",
      "taskClosedDate",
      "taskRecurrence",
    ]);
    const optionIds = [
      ...Object.values(TASK_STATUS_OPTION_UUIDS),
      ...Object.values(TASK_PRIORITY_OPTION_UUIDS),
    ];
    expect(new Set(optionIds).size).toBe(optionIds.length);
    for (const id of optionIds) {
      expect(id).toMatch(/^00000000-0000-0000-0004-/);
    }
    for (const entry of TASK_FAMILY_SEED) {
      expect(SYSTEM_PROPERTY_UUIDS).toHaveProperty(entry.property);
      expect(entry.sequence).toBeGreaterThan(0);
    }
    // Status/priority option labels match the v1 option vocabulary.
    expect(TASK_FAMILY_SEED[0]!.options!.map((o) => o.label)).toEqual([
      "Backlog",
      "Pending",
      "Doing",
      "Reviewing",
      "Done",
      "Cancelled",
    ]);
    expect(TASK_FAMILY_SEED[3]!.options!.map((o) => o.label)).toEqual([
      "Low",
      "Medium",
      "High",
      "Urgent",
    ]);
  });
});

describe("promotion survivors (§34.34 B3/B5)", () => {
  it("code_block survives stringifyContentAst; hr flattens away", async () => {
    const { stringifyContentAst, isTextOnlyContent } = await import("../src/index.js");
    const ast = [
      { type: "text" as const, text: "intro" },
      { type: "code_block" as const, language: "python", text: "print('hi')" },
      { type: "hr" as const },
      { type: "text" as const, text: "outro" },
    ];
    const flattened = stringifyContentAst(ast);
    expect(flattened).toEqual([
      { type: "text", text: "intro outro" },
      { type: "code_block", language: "python", text: "print('hi')" },
    ]);
    expect(isTextOnlyContent(flattened)).toBe(true);
    // A code-only stream keeps the code block and no text run.
    expect(
      stringifyContentAst([{ type: "code_block" as const, text: "x = 1" }]),
    ).toEqual([{ type: "code_block", text: "x = 1" }]);
  });
});
