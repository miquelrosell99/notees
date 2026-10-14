/**
 * Tab-title rule tests (law 9 — view surfaces own their tab title): the App's
 * ONE title writer names the open surface — the settings section, the open
 * node, the full-page search, then the active nav hub (Trash, Graph, Tasks,
 * Assets, …). The rule is the exported `tabTitle`; the effect only assigns.
 */

import { describe, expect, it } from "vitest";

import { tabTitle } from "../src/ui/App.js";

const base = {
  clientPresent: true,
  selectedPageId: null,
  settingsSection: null,
  searchOpen: false,
  activeNav: "journal",
  nodeName: "",
} as const;

describe("tabTitle", () => {
  it("names every nav hub (the stale-title fix: Trash, Graph, Tasks, Assets, …)", () => {
    const cases = [
      ["journal", "Journal"],
      ["calendar", "Calendar"],
      ["inbox", "Inbox"],
      ["pages", "Pages"],
      ["classes", "Classes"],
      ["whiteboards", "Whiteboards"],
      ["tasks", "Tasks"],
      ["assets", "Assets"],
      ["queries", "Queries"],
      ["graph", "Graph"],
      ["trash", "Trash"],
    ] as const;
    for (const [nav, label] of cases) {
      expect(tabTitle({ ...base, activeNav: nav }), nav).toBe(`${label} - Notees`);
    }
  });

  it("names the open node over the hub", () => {
    expect(
      tabTitle({ ...base, activeNav: "trash", selectedPageId: "x", nodeName: "My page" }),
    ).toBe("My page - Notees");
  });

  it("names the full-page search over the hub", () => {
    expect(tabTitle({ ...base, activeNav: "graph", searchOpen: true })).toBe("Search - Notees");
  });

  it("names the settings section over everything", () => {
    expect(
      tabTitle({
        ...base,
        settingsSection: "appearance",
        searchOpen: true,
        selectedPageId: "x",
        nodeName: "My page",
      }),
    ).toBe("Appearance - Notees");
  });

  it("falls back to the bare app name when signed out, even with a hub active", () => {
    expect(tabTitle({ ...base, clientPresent: false, activeNav: "trash" })).toBe("Notees");
  });

  it("an open node with an unknown name yields the bare app name", () => {
    expect(tabTitle({ ...base, selectedPageId: "x", nodeName: "" })).toBe("Notees");
  });
});
