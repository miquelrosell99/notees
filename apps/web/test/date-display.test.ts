/**
 * dateDisplay tests: compact date labels (storage form YYYYMMDD /
 * YYYYMM00 / YYYY0000) transform at display time per the user's dateFormat
 * device setting — titles, links, date properties all funnel through these
 * helpers. Identity comes from the deterministic date id first so migrated
 * pages (compact label in content, null name) never leak a raw YYYYMMDD.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  titleOfNode,
  titleOf,
  formatDateName,
  isDatePageNode,
  readDateFormat,
} from "../src/ui/dateDisplay.js";

const DAY_ID = "00000000-0000-0000-00dd-202906270000";

afterEach(() => localStorage.clear());

describe("formatDateName", () => {
  it("formats day labels with the setting's token layout", () => {
    expect(formatDateName("20290627", "YYYY/MM/DD")).toBe("2029/06/27");
    expect(formatDateName("20290627", "YYYY-MM-DD")).toBe("2029-06-27");
    expect(formatDateName("20290627", "DD/MM/YYYY")).toBe("27/06/2029");
    expect(formatDateName("20290627", "MM-DD-YYYY")).toBe("06-27-2029");
  });

  it("keeps canonical shapes for month and year labels", () => {
    expect(formatDateName("20290600", "DD/MM/YYYY")).toBe("2029/06");
    expect(formatDateName("20290000", "DD/MM/YYYY")).toBe("2029");
  });

  it("returns null for non-date names", () => {
    expect(formatDateName("Proyecto Implante")).toBeNull();
    expect(formatDateName("2029062")).toBeNull();
    expect(formatDateName("")).toBeNull();
  });
});

describe("titleOfNode — the capped default", () => {
  it("formats from the date id even with a null name (migrated pages)", () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("YYYY/MM/DD"));
    const node = { id: DAY_ID, isClass: false as const, isEmbedded: false as const, name: null, contentAst: [{ type: "text", text: "20290627" } as const] };
    expect(titleOfNode(node)).toBe("2029/06/27");
  });

  it("formats date-shaped titles per the setting (title-is-content)", () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("DD-MM-YYYY"));
    // The date label lives in the node's content now; a deterministic date id
    // marks it a date page so the user's token layout applies.
    const node = {
      id: DAY_ID,
      isClass: false as const, isEmbedded: false as const,
      name: null,
      contentAst: [{ type: "text", text: "20290627" } as const],
    };
    expect(titleOfNode(node)).toBe("27-06-2029");
  });

  it("defers to the derived name for everything else", () => {
    const node = {
      id: "some-uuid",
      isClass: false as const, isEmbedded: false as const,
      name: null,
      contentAst: [{ type: "text", text: "Derived from content" } as const],
    };
    expect(titleOfNode(node)).toBe("Derived from content");
  });
});

describe("titleOfNode — the chrome flatten", () => {
  it("reduces markdown link spans to their label (no href)", () => {
    const node = {
      id: "p1",
      isClass: false as const, isEmbedded: false as const,
      name: null,
      contentAst: [
        { type: "text", text: "Ver [Informe 2024](https://example.com/informe) hoy" } as const,
      ],
    };
    expect(titleOfNode(node, { flatten: "chrome" })).toBe("Ver Informe 2024 hoy");
  });

  it("strips before the cap — a long href cannot crowd the label out", () => {
    const node = {
      id: "p1",
      isClass: false as const, isEmbedded: false as const,
      name: null,
      contentAst: [
        {
          type: "text",
          text: `[Corto](https://example.com/${"x".repeat(120)})`,
        } as const,
      ],
    };
    expect(titleOfNode(node, { flatten: "chrome" })).toBe("Corto");
  });

  it("resolves inline class chips via resolveClassName (nothing without it)", () => {
    const node = {
      id: "p1",
      isClass: false as const, isEmbedded: false as const,
      name: null,
      contentAst: [
        { type: "text", text: "Reunión con " } as const,
        { type: "class_link", classId: "c1" } as const,
      ],
    };
    // Chrome passes the resolver: the chip's current name folds in.
    expect(titleOfNode(node, { flatten: "chrome", resolveClassName: () => "persona" })).toBe("Reunión con persona");
    // Domain-pure default: a bare chip contributes nothing.
    expect(titleOfNode(node, { flatten: "chrome" })).toBe("Reunión con");
  });

  it("resolves a mention to the target's current name — a link-only block never reads Untitled", () => {
    // The reported bug: a block whose content is ONLY a node link crumbed as
    // "Untitled" — the excerpt used the retired captured text (empty on
    // migrated mentions). Chrome flatten resolves the target instead.
    const linkOnly = {
      id: "b1",
      isClass: false as const, isEmbedded: true as const,
      parentId: "p1",
      name: null,
      contentAst: [{ type: "mention", targetNodeId: "t1" } as const],
    };
    expect(
      titleOfNode(linkOnly, {
        flatten: "chrome",
        resolveMentionName: () => "piperacillin tazobactam",
        empty: "untitled",
      }),
    ).toBe("piperacillin tazobactam");
    // Without the resolver the pure default is honestly empty (the
    // "Untitled" fallback belongs to the caller's label vocabulary).
    expect(titleOfNode(linkOnly, { flatten: "chrome", empty: "untitled" })).toBe("Untitled block");
    // A customLabel wins over the resolved name.
    const labeled = {
      ...linkOnly,
      contentAst: [{ type: "mention", targetNodeId: "t1", customLabel: "the Republic" } as const],
    };
    expect(
      titleOfNode(labeled, { flatten: "chrome", resolveMentionName: () => "resolved name" }),
    ).toBe("the Republic");
  });

  it("keeps the date formatting branch", () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("YYYY/MM/DD"));
    const node = {
      id: DAY_ID,
      isClass: false as const, isEmbedded: false as const,
      name: null,
      contentAst: [{ type: "text", text: "20290627" } as const],
    };
    expect(titleOfNode(node, { flatten: "chrome" })).toBe("2029/06/27");
  });
});

describe("titleOf — the client funnel", () => {
  it("formats date nodes and defers otherwise", () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("YYYY/MM/DD"));
    const nodes = new Map([
      [DAY_ID, { id: DAY_ID, isClass: false as const, isEmbedded: false as const, name: null, contentAst: [] }],
      ["p1", { id: "p1", isClass: false as const, isEmbedded: false as const, name: null, contentAst: [{ type: "text", text: "Plain" } as const] }],
    ]);
    const client = {
      getNode: (id: string) => nodes.get(id),
      getDisplayName: (id: string) => (id === "p1" ? "Plain" : null),
    };
    expect(titleOf(client, DAY_ID)).toBe("2029/06/27");
    expect(titleOf(client, "p1")).toBe("Plain");
    // Unknown id: defer to the client's own resolution.
    expect(titleOf(client, "ghost")).toBeNull();
  });
});

describe("isDatePageNode / readDateFormat", () => {
  it("detects date pages by deterministic id or date class only", () => {
    expect(isDatePageNode({ id: DAY_ID, name: null })).toBe(true);
    expect(
      isDatePageNode({ id: "x", name: null, classIds: ["00000000-0000-0000-0001-000000000005"] }),
    ).toBe(true);
    expect(isDatePageNode({ id: "x", name: "Plain" })).toBe(false);
  });

  it("an 8-digit title alone is NOT a date page", () => {
    expect(isDatePageNode({ id: "x", name: "20290627" })).toBe(false);
    expect(isDatePageNode({ id: "x", name: null })).toBe(false);
  });

  it("falls back to the hyphen default for unknown or missing settings", () => {
    expect(readDateFormat()).toBe("YYYY-MM-DD");
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("garbage"));
    expect(readDateFormat()).toBe("YYYY-MM-DD");
  });
});
