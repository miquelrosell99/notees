/**
 * dateDisplay tests: compact date labels (storage form YYYYMMDD /
 * YYYYMM00 / YYYY0000) transform at display time per the user's dateFormat
 * device setting — titles, links, date properties all funnel through these
 * helpers. Identity comes from the deterministic date id first so migrated
 * pages (compact label in content, null name) never leak a raw YYYYMMDD.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  displayNameForSettings,
  displayNameFromClient,
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

describe("displayNameForSettings", () => {
  it("formats from the date id even with a null name (migrated pages)", () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("YYYY/MM/DD"));
    const node = { id: DAY_ID, isClass: false as const, presentAsMain: true as const, name: null, contentAst: [{ type: "text", text: "20290627" } as const] };
    expect(displayNameForSettings(node)).toBe("2029/06/27");
  });

  it("formats date-shaped titles per the setting (title-is-content)", () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("DD-MM-YYYY"));
    // The date label lives in the node's content now; a deterministic date id
    // marks it a date page so the user's token layout applies.
    const node = {
      id: DAY_ID,
      isClass: false as const, presentAsMain: true as const,
      name: null,
      contentAst: [{ type: "text", text: "20290627" } as const],
    };
    expect(displayNameForSettings(node)).toBe("27-06-2029");
  });

  it("defers to the derived name for everything else", () => {
    const node = {
      id: "some-uuid",
      isClass: false as const, presentAsMain: true as const,
      name: null,
      contentAst: [{ type: "text", text: "Derived from content" } as const],
    };
    expect(displayNameForSettings(node)).toBe("Derived from content");
  });
});

describe("displayNameFromClient", () => {
  it("formats date nodes and defers otherwise", () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("YYYY/MM/DD"));
    const nodes = new Map([
      [DAY_ID, { id: DAY_ID, isClass: false as const, presentAsMain: true as const, name: null, contentAst: [] }],
      ["p1", { id: "p1", isClass: false as const, presentAsMain: true as const, name: null, contentAst: [{ type: "text", text: "Plain" } as const] }],
    ]);
    const client = {
      getNode: (id: string) => nodes.get(id),
      getDisplayName: (id: string) => (id === "p1" ? "Plain" : null),
    };
    expect(displayNameFromClient(client, DAY_ID)).toBe("2029/06/27");
    expect(displayNameFromClient(client, "p1")).toBe("Plain");
    // Unknown id: defer to the client's own resolution.
    expect(displayNameFromClient(client, "ghost")).toBeNull();
  });
});

describe("isDatePageNode / readDateFormat", () => {
  it("detects date pages by id, class, or name shape", () => {
    expect(isDatePageNode({ id: DAY_ID, name: null })).toBe(true);
    expect(
      isDatePageNode({ id: "x", name: null, classIds: ["00000000-0000-0000-0001-000000000005"] }),
    ).toBe(true);
    expect(isDatePageNode({ id: "x", name: "20290627" })).toBe(true);
    expect(isDatePageNode({ id: "x", name: "Plain" })).toBe(false);
  });

  it("falls back to the hyphen default for unknown or missing settings", () => {
    expect(readDateFormat()).toBe("YYYY-MM-DD");
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("garbage"));
    expect(readDateFormat()).toBe("YYYY-MM-DD");
  });
});
