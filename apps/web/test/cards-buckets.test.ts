/**
 * Cards-hub bucket tests: partitionCardsIntoBuckets derives the due /
 * fresh / later buckets from the cardDue day read (overdue-or-today → due,
 * never-scheduled → fresh, future → later), the cardRowsOf effective-value
 * read (the taskRowsOf precedent over the cardDue schema), and the
 * session-state handoff (startCardsSession writes the session payload and
 * navigates to /cards/review).
 */

import { describe, expect, it } from "vitest";

import {
  partitionCardsIntoBuckets,
  cardRowsOf,
  type CardBucketRow,
} from "../src/features/classview/CardBuckets.js";
import {
  CARDS_SESSION_STORAGE_KEY,
  startCardsSession,
} from "../src/features/cards/sessionState.js";
import { pathForCardsReview } from "../src/ui/app/routing.js";

describe("partitionCardsIntoBuckets", () => {
  it("partitions cards into due / fresh / later from cardDue", () => {
    const rows: CardBucketRow[] = [
      { id: "a", due: "2026-10-27" }, // overdue → due
      { id: "b", due: "2026-10-28" }, // today → due
      { id: "c", due: null }, // unseen → fresh
      { id: "d", due: "2026-11-02" }, // future → later
    ];
    const buckets = partitionCardsIntoBuckets(rows, "2026-10-28");
    expect(buckets.due.map((row) => row.id)).toEqual(["a", "b"]);
    expect(buckets.fresh.map((row) => row.id)).toEqual(["c"]);
    expect(buckets.later.map((row) => row.id)).toEqual(["d"]);
  });

  it("sorts due and later by day then id; fresh stays deterministic", () => {
    const rows: CardBucketRow[] = [
      { id: "z", due: null },
      { id: "b", due: "2026-10-26" },
      { id: "a", due: "2026-10-26" },
      { id: "c", due: "2026-11-01" },
      { id: "y", due: null },
    ];
    const buckets = partitionCardsIntoBuckets(rows, "2026-10-28");
    expect(buckets.due.map((row) => row.id)).toEqual(["a", "b"]);
    expect(buckets.fresh.map((row) => row.id)).toEqual(["z", "y"]);
    expect(buckets.later.map((row) => row.id)).toEqual(["c"]);
  });
});

describe("cardRowsOf (the effective cardDue read)", () => {
  it("reads the due day off the effective cardDue value; absent → null", async () => {
    const { dayNodeId } = await import("@notees/domain");
    const dueSchemaId = "00000000-0000-0000-0004-000000000001";
    const client = {
      getEffectiveProperties: (id: string) =>
        id === "with-due"
          ? [
              {
                propertySchemaId: dueSchemaId,
                // The datetime point value: a day-chain node ref (the slot
                // grammar), read through the same slot helpers the task
                // rows use.
                value: { nodeId: dayNodeId("2026-10-27") },
              },
            ]
          : [],
    };
    const rows = cardRowsOf(client as never, dueSchemaId, ["with-due", "without-due"]);
    expect(rows).toEqual([
      { id: "with-due", due: "2026-10-27" },
      { id: "without-due", due: null },
    ]);
    const buckets = partitionCardsIntoBuckets(rows, "2026-10-28");
    expect(buckets.due.map((row) => row.id)).toEqual(["with-due"]);
    expect(buckets.fresh.map((row) => row.id)).toEqual(["without-due"]);
  });
});

describe("startCardsSession (the review handoff)", () => {
  it("writes the session payload and navigates to /cards/review", () => {
    window.history.replaceState({}, "", "/cards");
    startCardsSession(["a", "b"], "test filter");
    const stored = window.sessionStorage.getItem(CARDS_SESSION_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual({ cardIds: ["a", "b"], filterSummary: "test filter" });
    expect(window.location.pathname).toBe(pathForCardsReview());
  });
});
