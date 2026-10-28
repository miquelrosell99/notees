/**
 * Review-session tests (Task 10): the /cards/review surface over a real
 * seeded client (jsdom + in-process WorkspaceClient + MemoryRelay, the
 * deck-view harness). Pins: front-without-back before reveal; the back +
 * the four grade buttons after reveal; the Good write path (the six
 * card-family property values carry the next SRS state; exactly one
 * card.review envelope per grade, grade/algorithm/sessionId pinned); the
 * front-only empty state (Review Focus 1); the undo contract (Review
 * Focus 5 — undoing reverts the property writes, the history row stays,
 * the card.review op never enters the journal).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { CARD_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS, UNSEEN_CARD_STATE } from "@notees/domain";
import type { OpPayload } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { scheduledIsoOf, todayIsoLocal } from "../src/features/calendar/calendarViewUtils.js";
import { CARDS_SESSION_STORAGE_KEY } from "../src/features/cards/sessionState.js";
import { getCardsAlgorithm, resetNodePrefsForTests, setCardsAlgorithm } from "../src/features/settings/nodePrefs.js";
import { nextCardState } from "@notees/domain";
import { ReviewSession } from "../src/features/cards/ReviewSession.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  sessionStorage.clear();
  resetNodePrefsForTests();
});

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Flush the microtasks an async client write runs on. */
async function flush(): Promise<void> {
  await act(async () => {});
}

async function seedCard(client: WorkspaceClient, front: string, back?: string): Promise<string> {
  const id = await client.createObject({
    isEmbedded: false,
    classIds: [SYSTEM_CLASS_UUIDS.card],
    contentAst: [{ type: "text", text: front }],
  });
  if (back !== undefined) {
    await client.createObject({
      parentId: id,
      isEmbedded: true,
      contentAst: [{ type: "text", text: back }],
    });
  }
  return id;
}

function startSession(cardIds: string[]): void {
  sessionStorage.setItem(
    CARDS_SESSION_STORAGE_KEY,
    JSON.stringify({ cardIds, filterSummary: "All cards" }),
  );
}

function startReview(client: WorkspaceClient, onExit: () => void = () => {}) {
  return render(<ReviewSession client={client} onExit={onExit} />);
}

function gradeButtons(): string[] {
  return ["Again", "Hard", "Good", "Easy"].map(
    (label) => screen.getByRole("button", { name: label }).textContent ?? "",
  );
}

function effectiveValue(client: WorkspaceClient, id: string, schemaId: string): unknown {
  return client.getEffectiveProperties(id).find((row) => row.propertySchemaId === schemaId)
    ?.value;
}

describe("ReviewSession", () => {
  it("renders the front and NOT the back before reveal", async () => {
    const client = await seedClient();
    const cardId = await seedCard(client, "The front question", "The back answer");
    startSession([cardId]);

    startReview(client);
    await flush();

    expect(screen.getByText("The front question")).toBeTruthy();
    expect(screen.queryByText("The back answer")).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
    // No grading before the reveal.
    expect(screen.queryByRole("button", { name: "Good" })).toBeNull();
  });

  it("reveal renders the embedded children (the back) and the four grade buttons", async () => {
    const client = await seedClient();
    const cardId = await seedCard(client, "The front question", "The back answer");
    startSession([cardId]);

    startReview(client);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));

    expect(screen.getByText("The back answer")).toBeTruthy();
    expect(gradeButtons()).toEqual(["Again", "Hard", "Good", "Easy"]);
  });

  it("Good writes the next-state property values and one card.review envelope per grade", async () => {
    const client = await seedClient();
    const first = await seedCard(client, "First card", "First answer");
    const second = await seedCard(client, "Second card", "Second answer");
    startSession([first, second]);
    const reviews = vi.spyOn(client, "recordCardReview");

    startReview(client);
    await flush();

    const today = todayIsoLocal();
    const expected = nextCardState(UNSEEN_CARD_STATE, "good", "fsrs", today);

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "Good" }));
    await flush();

    // The six property values carry the schedule (fsrs good on an unseen
    // card: due today, reps 1, interval 0, difficulty/stability initialized,
    // ease untouched).
    expect(scheduledIsoOf(effectiveValue(client, first, CARD_PROPERTY_UUIDS.cardDue))).toBe(
      expected.due,
    );
    expect(effectiveValue(client, first, CARD_PROPERTY_UUIDS.cardReps)).toBe(expected.reps);
    expect(effectiveValue(client, first, CARD_PROPERTY_UUIDS.cardInterval)).toBe(expected.interval);
    expect(effectiveValue(client, first, CARD_PROPERTY_UUIDS.cardDifficulty)).toBeCloseTo(
      expected.difficulty ?? -1,
      6,
    );
    expect(effectiveValue(client, first, CARD_PROPERTY_UUIDS.cardStability)).toBeCloseTo(
      expected.stability ?? -1,
      6,
    );
    expect(effectiveValue(client, first, CARD_PROPERTY_UUIDS.cardEase) ?? null).toBeNull();

    // Exactly one card.review envelope: grade good, the current pref
    // algorithm, the full state transition.
    expect(reviews).toHaveBeenCalledTimes(1);
    const payload = reviews.mock.calls[0]![0] as OpPayload<"card.review">;
    expect(payload.grade).toBe("good");
    expect(payload.algorithm).toBe("fsrs");
    expect(payload.cardId).toBe(first);
    expect(payload.stateBefore).toEqual(UNSEEN_CARD_STATE);
    expect(payload.stateAfter.due).toBe(expected.due);
    const firstSessionId = payload.sessionId;

    // The queue advanced to the second card; grading it shares the sessionId.
    expect(screen.getByText("Second card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "Good" }));
    await flush();

    expect(reviews).toHaveBeenCalledTimes(2);
    const secondPayload = reviews.mock.calls[1]![0] as OpPayload<"card.review">;
    expect(secondPayload.cardId).toBe(second);
    expect(secondPayload.sessionId).toBe(firstSessionId);
    // The session is done: summary + the back-to-cards action.
    expect(screen.getByText(/2 cards reviewed/)).toBeTruthy();
  });

  it("grades a front-only card through the empty state (Review Focus 1)", async () => {
    const client = await seedClient();
    const cardId = await seedCard(client, "Front only");
    startSession([cardId]);

    startReview(client);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));

    expect(screen.getByText("No answer on this card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Easy" }));
    await flush();

    const today = todayIsoLocal();
    expect(scheduledIsoOf(effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardDue))).toBe(
      nextCardState(UNSEEN_CARD_STATE, "easy", "fsrs", today).due,
    );
    expect(screen.getByText(/1 card reviewed/)).toBeTruthy();
  });

  it("undo reverts the WHOLE grade in one gesture; the card.review history row stays (Review Focus 5)", async () => {
    const client = await seedClient();
    const cardId = await seedCard(client, "Undo card", "Undo answer");
    startSession([cardId]);

    startReview(client);
    await flush();

    const depthBefore = client.undoDepth().undo;
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "Good" }));
    await flush();

    // The grade's schedule writes (5 property writes + the due-day
    // date-chain creates they trigger) journal as ONE entry — a grade is a
    // single gesture. The card.review op itself never enters the journal.
    const journaled = client.undoDepth().undo - depthBefore;
    expect(journaled).toBe(1);
    // The history row landed in the derived projection.
    const historyCount = (
      client.store.database.prepare("SELECT COUNT(*) AS n FROM card_review").get() as { n: number }
    ).n;
    expect(historyCount).toBe(1);

    // ONE undo reverts every property write of the grade.
    await client.undo();
    await flush();

    expect(effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardReps)).not.toBe(1);
    expect(effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardInterval)).not.toBe(0);
    expect(effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardDifficulty) ?? null).toBeNull();
    expect(
      scheduledIsoOf(effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardDue)),
    ).toBeNull();
    expect(client.undoDepth().undo).toBe(depthBefore);
    // The history row SURVIVES the undo — a review cannot be un-happened.
    const historyAfter = (
      client.store.database.prepare("SELECT COUNT(*) AS n FROM card_review").get() as { n: number }
    ).n;
    expect(historyAfter).toBe(1);
  });

  it("the sm2 grade writes the ease factor and leaves the fsrs fields stale", async () => {
    setCardsAlgorithm("sm2");
    try {
      const client = await seedClient();
      const cardId = await seedCard(client, "SM2 card", "SM2 answer");
      startSession([cardId]);
      const reviews = vi.spyOn(client, "recordCardReview");

      startReview(client);
      await flush();

      const today = todayIsoLocal();
      const expected = nextCardState(UNSEEN_CARD_STATE, "good", "sm2", today);

      fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
      fireEvent.click(screen.getByRole("button", { name: "Good" }));
      await flush();

      // SM-2 good on an unseen card: interval 1 day (due tomorrow), the
      // ease factor initialized at 2.5 and moved by the quality-4 update.
      expect(scheduledIsoOf(effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardDue))).toBe(
        expected.due,
      );
      expect(effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardReps)).toBe(expected.reps);
      expect(effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardInterval)).toBe(
        expected.interval,
      );
      expect(effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardEase)).toBeCloseTo(
        expected.ease ?? -1,
        6,
      );
      // The fsrs fields stay untouched (byte-for-byte stale = null here).
      expect(
        effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardDifficulty) ?? null,
      ).toBeNull();
      expect(
        effectiveValue(client, cardId, CARD_PROPERTY_UUIDS.cardStability) ?? null,
      ).toBeNull();
      // The envelope records which scheduler ran.
      expect(reviews).toHaveBeenCalledTimes(1);
      expect((reviews.mock.calls[0]![0] as OpPayload<"card.review">).algorithm).toBe("sm2");
    } finally {
      setCardsAlgorithm("fsrs");
    }
  });

  it("the exit action leaves the session for the cards hub", async () => {
    const client = await seedClient();
    const cardId = await seedCard(client, "Exit card");
    startSession([cardId]);
    const onExit = vi.fn();

    startReview(client, onExit);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Exit review" }));

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
