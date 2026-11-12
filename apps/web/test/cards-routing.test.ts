/**
 * Cards-hub routing tests:
 * the /cards hub path ↔ nav-key mapping, the /cards/review subroute's
 * hub landing (the calendar precedent — any /cards/* path boots the cards
 * hub), and tabTitle's cards branch (law 9 — the surface owns its URL AND
 * its tab title).
 */

import { describe, expect, it } from "vitest";

import {
  cardsReviewFromPath,
  navFromPath,
  pathForCardsReview,
  pathForNav,
  tabTitle,
} from "../src/ui/app/routing.js";

describe("the cards hub's path mapping (law 9)", () => {
  it("the cards hub owns its path and tab title", () => {
    const base = {
      clientPresent: true,
      selectedPageId: null,
      settingsSection: null,
      searchOpen: false,
      activeNav: "cards" as const,
      nodeName: "",
    };
    expect(pathForNav("cards")).toBe("/cards");
    expect(navFromPath("/cards")).toBe("cards");
    expect(tabTitle(base)).toBe("Cards - Notees");
    // The hub register names the surface; an open node still wins.
    expect(tabTitle({ ...base, selectedPageId: "x", nodeName: "My card" })).toBe("My card - Notees");
  });

  it("any /cards/* path lands on the cards hub (the /cards/review subroute)", () => {
    expect(navFromPath("/cards/review")).toBe("cards");
    expect(navFromPath("/cards/review/")).toBe("cards");
  });

  it("the review path is a stable exported constant", () => {
    expect(pathForCardsReview()).toBe("/cards/review");
  });

  it("the review surface owns its tab title (law 9 — 'Review - Notees')", () => {
    const base = {
      clientPresent: true,
      selectedPageId: null,
      settingsSection: null,
      searchOpen: false,
      activeNav: "cards" as const,
      nodeName: "",
    };
    expect(cardsReviewFromPath("/cards/review")).toBe(true);
    expect(cardsReviewFromPath("/cards/review/")).toBe(true);
    expect(cardsReviewFromPath("/cards")).toBe(false);
    expect(tabTitle({ ...base, cardsReview: true })).toBe("Review - Notees");
    // The hub keeps its own title off the subroute.
    expect(tabTitle(base)).toBe("Cards - Notees");
    // An open node still wins over the review surface.
    expect(
      tabTitle({ ...base, cardsReview: true, selectedPageId: "x", nodeName: "My card" }),
    ).toBe("My card - Notees");
  });
});
