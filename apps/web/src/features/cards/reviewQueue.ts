/**
 * reviewQueue — the review session's card order (Task 10).
 *
 * The session reviews the due set first — overdue and due-today ahead of
 * future-due, every scheduled arm due-date ascending (string compare on
 * YYYY-MM-DD is chronological, the `isCardDue` contract) — then the fresh
 * (never-scheduled) cards in input order: there is no day to sort a fresh
 * card by. A hand-off may carry not-yet-due cards (the hub's Review-now
 * covers the filtered list, Later members included) — they ride after the
 * due arm, day-ascending, still ahead of fresh: reviewing them early is
 * allowed, never preferred. The rows carry only what the ordering needs —
 * the id and the effective `Card due` day — the render-side reads
 * (front/back content, SRS state) re-read the client.
 */

/** One orderable card row: the id plus the effective cardDue day (null = fresh). */
export interface ReviewQueueRow {
  id: string;
  due: string | null;
}

/**
 * The session's review order, ids only: due cards (due ≤ today) sorted by
 * due-date ascending — overdue first by construction — then future-due
 * cards day-ascending (a hand-off may carry Later members; early review is
 * allowed, never preferred), then fresh cards in input order.
 */
export function buildReviewQueue(
  rows: ReadonlyArray<ReviewQueueRow>,
  todayIso: string,
): string[] {
  const due: ReviewQueueRow[] = [];
  const future: ReviewQueueRow[] = [];
  const fresh: ReviewQueueRow[] = [];
  for (const row of rows) {
    if (row.due === null) fresh.push(row);
    else if (row.due <= todayIso) due.push(row);
    else future.push(row);
  }
  const byDay = (a: ReviewQueueRow, b: ReviewQueueRow) =>
    (a.due ?? "").localeCompare(b.due ?? "") || a.id.localeCompare(b.id);
  due.sort(byDay);
  future.sort(byDay);
  return [...due, ...future, ...fresh].map((row) => row.id);
}
