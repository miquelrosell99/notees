/**
 * Review-queue ordering tests (Task 10): due cards first — overdue before
 * due-today before future-due, each arm due-date ascending — then the fresh
 * (never-scheduled) cards in input order. Ids only out; the session's
 * render order is the queue order verbatim.
 */

import { describe, expect, it } from "vitest";

import { buildReviewQueue } from "../src/features/cards/reviewQueue.js";

describe("buildReviewQueue", () => {
  it("orders due (overdue first, then due-date asc) ahead of fresh", () => {
    const q = buildReviewQueue(
      [
        { id: "fresh1", due: null },
        { id: "dueTomorrow", due: "2026-10-29" },
        { id: "overdue", due: "2026-10-20" },
        { id: "dueToday", due: "2026-10-28" },
      ],
      "2026-10-28",
    );
    expect(q).toEqual(["overdue", "dueToday", "dueTomorrow", "fresh1"]);
  });

  it("keeps fresh cards in input order (there is no day to sort by)", () => {
    const q = buildReviewQueue(
      [
        { id: "freshB", due: null },
        { id: "freshA", due: null },
        { id: "overdue", due: "2026-10-20" },
      ],
      "2026-10-28",
    );
    expect(q).toEqual(["overdue", "freshB", "freshA"]);
  });

  it("is stable on the due arm (same day keeps input order)", () => {
    const q = buildReviewQueue(
      [
        { id: "due1", due: "2026-10-28" },
        { id: "due2", due: "2026-10-28" },
        { id: "earlier", due: "2026-10-27" },
      ],
      "2026-10-28",
    );
    expect(q).toEqual(["earlier", "due1", "due2"]);
  });

  it("places a future-due card after the due arm, before fresh (early review allowed, never preferred)", () => {
    const q = buildReviewQueue([{ id: "later", due: "2026-10-29" }], "2026-10-28");
    expect(q).toEqual(["later"]);
  });
});
