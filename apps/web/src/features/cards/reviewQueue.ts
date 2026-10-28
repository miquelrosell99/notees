/**
 * reviewQueue — the review session's card order (Task 10).
 *
 * The session reviews the due set first — overdue and due-today ahead of
 * each other by date alone, the whole arm due-date ascending (string
 * compare on YYYY-MM-DD is chronological, the `isCardDue` contract) —
 * then the fresh (never-scheduled) cards in input order: there is no day
 * to sort a fresh card by. A card with a FUTURE due date is not reviewable
 * yet and never enters the queue (the spec's Queue = due-then-new ruling;
 * the Later bucket's set) — a hand-off may carry such ids, the queue drops
 * them. The rows carry only what the ordering needs — the id and the
 * effective `Card due` day — the render-side reads (front/back content,
 * SRS state) re-read the client.
 */

/** One orderable card row: the id plus the effective cardDue day (null = fresh). */
export interface ReviewQueueRow {
  id: string;
  due: string | null;
}

/**
 * The session's review order, ids only: due cards (due ≤ today) sorted by
 * due-date ascending — overdue first by construction — then fresh cards in
 * input order. Future-due rows are NOT reviewable and never enter the
 * queue (the spec's Queue = due-then-new ruling), whatever the hand-off
 * carried.
 */
export function buildReviewQueue(
  rows: ReadonlyArray<ReviewQueueRow>,
  todayIso: string,
): string[] {
  const due: ReviewQueueRow[] = [];
  const fresh: ReviewQueueRow[] = [];
  for (const row of rows) {
    if (row.due === null) fresh.push(row);
    else if (row.due <= todayIso) due.push(row);
    // Future-due: excluded — the Later bucket's set, never the session's.
  }
  due.sort(
    (a, b) => (a.due ?? "").localeCompare(b.due ?? "") || a.id.localeCompare(b.id),
  );
  return [...due, ...fresh].map((row) => row.id);
}
