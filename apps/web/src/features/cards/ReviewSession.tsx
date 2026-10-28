/**
 * ReviewSession — the /cards/review surface (Task 10): the reveal +
 * four-grade study flow over the Cards hub's hand-off.
 *
 * Queue: the hub's Review gestures store `{ cardIds, filterSummary }` under
 * `notees.cards.session` (sessionState.ts) — those ids ARE the session;
 * consumed on mount (the deep link with no/corrupt stored session falls
 * back to every card-classed member, due AND fresh, `buildReviewQueue`
 * ordering them due-first). The session reads each card's SRS state from
 * the six card-family PROPERTY VALUES (the schedule's sole authority) —
 * missing/unparseable fields read as `UNSEEN_CARD_STATE`.
 *
 * Render: the front is the card node's own content read-only (the ProseView
 * single-item pattern); Reveal flips to the back — the same row plus its
 * embedded children in the condensed prose layer. A FRONT-ONLY card (zero
 * embedded children) renders the kit empty state ("No answer on this
 * card") and still grades (Review Focus 1).
 *
 * Grading: `nextCardState` computes the next SRS state with the session's
 * algorithm (read once at mount from the cards.algorithm pref). The
 * property writes compose exactly like taskCycle composes its status write
 * — one write per touched value, addressed at the row's EXISTING idx (the
 * inactive algorithm's fields stay byte-for-byte stale, per the srs.ts
 * mid-deck switch contract). The card.review envelope then appends through
 * the client's single op seam — the op is audit history ONLY and never
 * enters the undo journal (a review cannot be un-happened; undoing a grade
 * reverts the property writes, the history row stays — Review Focus 5).
 *
 * Law 9: /cards/review is the review surface's own deep-linkable URL (the
 * nav register lands any /cards/* path on the cards hub; AppBody branches
 * on the subroute) and the App's title effect names it "Review - Notees".
 */

import { useEffect, useRef, useState } from "react";

import {
  CARD_PROPERTY_UUIDS,
  SYSTEM_CLASS_UUIDS,
  nextCardState,
  type CardGrade,
  type CardSrsState,
  type SrsAlgorithm,
} from "@notees/domain";
import type { OpPayload } from "@notees/protocol";

import type { AnyClient } from "../../ui/app/clients.js";
import type { ClientNode, EffectiveProperty } from "@/core/workspace-client/index.js";
import { OutlinerContext, useOutlinerValue } from "../../ui/outliner-context.js";
import { ProseView } from "../collection/ProseView.js";
import type { NodeCollectionItem } from "../collection/types.js";
import { readCardsSession, clearCardsSession } from "./sessionState.js";
import { buildReviewQueue, type ReviewQueueRow } from "./reviewQueue.js";
import { getCardsAlgorithm } from "../settings/nodePrefs.js";
import { scheduledIsoOf, todayIsoLocal } from "../calendar/calendarViewUtils.js";
import { SurfaceTopBar } from "../../components/ui/kit/SurfaceTopBar.js";
import { Button } from "../../components/ui/kit/Button.js";
import { EmptyState } from "../../components/ui/kit/EmptyState.js";
import { Spinner } from "../../components/ui/kit/Spinner.js";
import "./ReviewSession.css";

/** The four grades in key order (1–4 on the keyboard). */
const GRADES: Array<{ grade: CardGrade; label: string }> = [
  { grade: "again", label: "Again" },
  { grade: "hard", label: "Hard" },
  { grade: "good", label: "Good" },
  { grade: "easy", label: "Easy" },
];

/** One loaded card: the node, its embedded children (the back), the SRS state. */
interface LoadedCard {
  id: string;
  node: ClientNode;
  children: ClientNode[];
  state: CardSrsState;
}

/**
 * The six card-family property values → a `CardSrsState`: missing or
 * unparseable fields read as the unseen defaults (the effective read is the
 * schedule's authority — a corrupt row reads as never-reviewed, never
 * crashes the session).
 */
function srsStateOf(props: EffectiveProperty[]): CardSrsState {
  const valueOf = (schemaId: string): unknown =>
    props.find((row) => row.propertySchemaId === schemaId)?.value;
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    due: scheduledIsoOf(valueOf(CARD_PROPERTY_UUIDS.cardDue)),
    reps: num(valueOf(CARD_PROPERTY_UUIDS.cardReps)) ?? 0,
    interval: num(valueOf(CARD_PROPERTY_UUIDS.cardInterval)) ?? 0,
    ease: num(valueOf(CARD_PROPERTY_UUIDS.cardEase)),
    difficulty: num(valueOf(CARD_PROPERTY_UUIDS.cardDifficulty)),
    stability: num(valueOf(CARD_PROPERTY_UUIDS.cardStability)),
  };
}

export function ReviewSession({
  client,
  onExit,
}: {
  client: AnyClient;
  /** The exit action: the App's navigate callback back to /cards (the hub). */
  onExit: () => void;
}) {
  const [cards, setCards] = useState<LoadedCard[] | null>(null);
  const [filterSummary, setFilterSummary] = useState("");
  /** The session's scheduler — read once at mount; the op records which ran. */
  const [algorithm, setAlgorithm] = useState<SrsAlgorithm | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [grading, setGrading] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [lapses, setLapses] = useState(0);
  /** One study session's identity — shared by every card.review op. */
  const [sessionId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = readCardsSession();
      if (session !== null) {
        // The hand-off is consumed by THIS session — a later deep link must
        // not resurrect it (the all-due fallback is its honest meaning then).
        clearCardsSession();
        setFilterSummary(session.filterSummary);
      }
      let ids = session?.cardIds ?? null;
      if (ids === null) {
        // Deep-link fallback: every card-classed member, due AND fresh —
        // the queue orders due-first and the session may stop anytime.
        const members = await client.getClassMembers(SYSTEM_CLASS_UUIDS.card);
        ids = members.map((member) => member.id);
      }
      const rows: ReviewQueueRow[] = [];
      for (const id of ids) {
        const props = await client.getEffectiveProperties(id);
        rows.push({
          id,
          due: scheduledIsoOf(
            props.find((row) => row.propertySchemaId === CARD_PROPERTY_UUIDS.cardDue)?.value,
          ),
        });
      }
      const queue = buildReviewQueue(rows, todayIsoLocal());
      const loaded: LoadedCard[] = [];
      for (const id of queue) {
        const node = await client.getNode(id);
        if (node === undefined) continue; // vanished between hand-off and open
        loaded.push({
          id,
          node,
          children: await client.getChildren(id),
          state: srsStateOf(await client.getEffectiveProperties(id)),
        });
      }
      if (!cancelled) setCards(loaded);
    })().catch((error: unknown) => {
      console.warn("[review] session load failed:", error);
      if (!cancelled) setCards([]);
    });
    void getCardsAlgorithm().then((pref) => {
      if (!cancelled) setAlgorithm(pref);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const card = cards !== null && index < cards.length ? cards[index]! : null;

  const grade = async (gradeValue: CardGrade): Promise<void> => {
    if (card === null || algorithm === null || grading) return;
    const stateBefore = card.state;
    const stateAfter = nextCardState(stateBefore, gradeValue, algorithm, todayIsoLocal());
    setGrading(true);
    try {
      // The property writes compose like taskCycle's status write: one write
      // per touched value, re-reading the rows at write time and addressing
      // each at its EXISTING idx (never a hard-coded 0). The inactive
      // algorithm's fields stay byte-for-byte stale (the srs.ts contract).
      const props = await client.getEffectiveProperties(card.id);
      const idxOf = (schemaId: string): number =>
        props.find((row) => row.propertySchemaId === schemaId)?.idx ?? 0;
      await client.setDatetimeProperty(
        card.id,
        CARD_PROPERTY_UUIDS.cardDue,
        { iso: stateAfter.due! },
        idxOf(CARD_PROPERTY_UUIDS.cardDue),
      );
      await client.setProperty(
        card.id,
        CARD_PROPERTY_UUIDS.cardReps,
        stateAfter.reps,
        idxOf(CARD_PROPERTY_UUIDS.cardReps),
      );
      await client.setProperty(
        card.id,
        CARD_PROPERTY_UUIDS.cardInterval,
        stateAfter.interval,
        idxOf(CARD_PROPERTY_UUIDS.cardInterval),
      );
      if (algorithm === "sm2") {
        await client.setProperty(
          card.id,
          CARD_PROPERTY_UUIDS.cardEase,
          stateAfter.ease,
          idxOf(CARD_PROPERTY_UUIDS.cardEase),
        );
      } else {
        await client.setProperty(
          card.id,
          CARD_PROPERTY_UUIDS.cardDifficulty,
          stateAfter.difficulty,
          idxOf(CARD_PROPERTY_UUIDS.cardDifficulty),
        );
        await client.setProperty(
          card.id,
          CARD_PROPERTY_UUIDS.cardStability,
          stateAfter.stability,
          idxOf(CARD_PROPERTY_UUIDS.cardStability),
        );
      }
      // The audit-history record — appended through the single op seam;
      // invertEnvelope has no case for card.review, so it never joins the
      // undo journal (the history row stays when a grade is undone).
      const payload: OpPayload<"card.review"> = {
        cardId: card.id,
        grade: gradeValue,
        algorithm,
        stateBefore,
        stateAfter,
        reviewedAt: new Date().toISOString(),
        sessionId,
      };
      await client.recordCardReview(payload);
    } finally {
      setGrading(false);
    }
    setReviewed((n) => n + 1);
    if (gradeValue === "again" && stateBefore.reps > 0) setLapses((n) => n + 1);
    setRevealed(false);
    setIndex((i) => i + 1);
  };

  // The 1–4 grade keys: active only while the back is up (the editor-
  // interaction rule — nothing editable owns the focus on this surface).
  const gradeRef = useRef(grade);
  gradeRef.current = grade;
  useEffect(() => {
    if (!revealed) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const at = ["1", "2", "3", "4"].indexOf(event.key);
      if (at >= 0) {
        event.preventDefault();
        void gradeRef.current(GRADES[at]!.grade);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [revealed]);

  // ProseView's BlockRow consumes the outliner context (the DeckView
  // precedent): a session-rooted provider with inert navigation — the
  // review surface owns no open-page flow.
  const outliner = useOutlinerValue(client, "cards.review", {
    openNode: () => {},
    openInSidebar: () => {},
  });

  if (cards === null || algorithm === null) {
    return (
      <div className="nt-review-session nt-review-session--loading">
        <Spinner aria-label="Loading cards" />
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <OutlinerContext.Provider value={outliner}>
        <div className="nt-review-session">
          <SurfaceTopBar
            icon="mdi-cards-playing-outline"
            title="Review"
            actions={
              <Button size="sm" variant="ghost" icon="mdi-close" aria-label="Exit review" onClick={onExit} />
            }
          />
          <div className="nt-hub__body">
            <div className="nt-hub__content">
              <EmptyState
                title="Nothing to review"
                description="No cards are due. New cards appear here once the card class is assigned."
                actionLabel="Back to cards"
                onAction={onExit}
              />
            </div>
          </div>
        </div>
      </OutlinerContext.Provider>
    );
  }

  const done = index >= cards.length;
  const frontItems: NodeCollectionItem[] = card !== null ? [{ node: card.node }] : [];
  const backItems: NodeCollectionItem[] =
    card !== null
      ? [{ node: card.node, children: card.children.map((child) => ({ node: child })) }]
      : [];

  return (
    <OutlinerContext.Provider value={outliner}>
      <div className="nt-review-session">
        <SurfaceTopBar
        icon="mdi-cards-playing-outline"
        title="Review"
        count={cards.length}
        context={
          done
            ? undefined
            : `${index + 1} of ${cards.length}${filterSummary !== "" ? ` · ${filterSummary}` : ""}`
        }
        actions={
          <Button size="sm" variant="ghost" icon="mdi-close" aria-label="Exit review" onClick={onExit} />
        }
      />
      <div className="nt-hub__body">
        <div className="nt-hub__content nt-review-session__content">
          {done ? (
            <div className="nt-review-session__summary">
              <h2>{`${reviewed} card${reviewed === 1 ? "" : "s"} reviewed`}</h2>
              {lapses > 0 && <p>{`${lapses} lapse${lapses === 1 ? "" : "s"}`}</p>}
              <Button variant="primary" onClick={onExit}>
                Back to cards
              </Button>
            </div>
          ) : (
            <>
              <div className="nt-review-session__card">
                <ProseView
                  client={client}
                  items={revealed ? backItems : frontItems}
                  {...(revealed && card !== null && card.children.length > 0 ? { condensed: true } : {})}
                />
                {revealed && card !== null && card.children.length === 0 && (
                  /* Front-only card (Review Focus 1): no embedded children —
                     the back names its emptiness and grading still works. */
                  <EmptyState title="No answer on this card" />
                )}
              </div>
              {!revealed ? (
                <div className="nt-review-session__reveal">
                  <Button variant="primary" onClick={() => setRevealed(true)}>
                    Reveal
                  </Button>
                </div>
              ) : (
                <div className="nt-review-session__grades" role="group" aria-label="Grade">
                  {GRADES.map(({ grade: gradeValue, label }) => (
                    <Button
                      key={gradeValue}
                      variant={gradeValue === "again" ? "danger" : "default"}
                      disabled={grading}
                      onClick={() => void grade(gradeValue)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      </div>
    </OutlinerContext.Provider>
  );
}
