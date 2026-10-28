/**
 * CardBuckets — the Cards hub's bucket strip: Due / Fresh / Later over the
 * hub's (filtered) card members, computed client-side from the effective
 * cardDue value — the same derived read the review session schedules from,
 * so no query ever runs. A card lands in exactly one bucket: its cardDue
 * day on or before today → Due (overdue or due today), no cardDue value
 * (never reviewed) → Fresh, a future cardDue day → Later. Renders as three
 * chips with counts above the hub collection (the CollectionHub `prepend`
 * slot); the Due chip starts a review session over the due + fresh set.
 */

import { Button } from "../../components/ui/kit/Button.js";
import { Pill } from "../../components/ui/kit/Pill.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import { scheduledIsoOf } from "../calendar/calendarViewUtils.js";
import "./CardBuckets.css";

/**
 * One card row's bucket facts: the cardDue day (YYYY-MM-DD), null when the
 * card has never been scheduled (no cardDue value).
 */
export interface CardBucketRow {
  id: string;
  due: string | null;
}

export interface CardBuckets {
  /** cardDue day on or before today — overdue or due now. */
  due: CardBucketRow[];
  /** No cardDue value — the never-reviewed set. */
  fresh: CardBucketRow[];
  /** cardDue day after today. */
  later: CardBucketRow[];
}

/**
 * The cards-bucket partition: due-or-before-today → Due, no day → Fresh,
 * future → Later. Due and Later sort by day then id; Fresh keeps input
 * order (there is no day to sort by).
 */
export function partitionCardsIntoBuckets(
  rows: readonly CardBucketRow[],
  todayIso: string,
): CardBuckets {
  const due: CardBucketRow[] = [];
  const fresh: CardBucketRow[] = [];
  const later: CardBucketRow[] = [];
  for (const row of rows) {
    if (row.due === null) fresh.push(row);
    else if (row.due <= todayIso) due.push(row);
    else later.push(row);
  }
  const byDay = (a: CardBucketRow, b: CardBucketRow) =>
    (a.due ?? "").localeCompare(b.due ?? "") || a.id.localeCompare(b.id);
  due.sort(byDay);
  later.sort(byDay);
  return { due, fresh, later };
}

/**
 * Bucket facts for every member of a list, in input order — the effective
 * cardDue read (the datetime slot grammar through the same slot helpers
 * the task rows use; a point reads its day, a range its start day).
 */
export function cardRowsOf(
  client: Pick<AnyClient, "getEffectiveProperties">,
  dueSchemaId: string,
  ids: readonly string[],
): CardBucketRow[] {
  return ids.map((id) => {
    const value = client
      .getEffectiveProperties(id)
      .find((prop) => prop.propertySchemaId === dueSchemaId)?.value;
    return { id, due: scheduledIsoOf(value) };
  });
}

/**
 * The bucket strip: three count chips. The Due chip is the review action —
 * a session over the due + fresh ids (the due-now and never-seen sets; a
 * future card is not reviewable yet). Nothing to bucket: the hub
 * collection's own empty state covers it.
 */
export function CardBuckets({
  buckets,
  onReview,
}: {
  buckets: CardBuckets;
  onReview: (ids: string[]) => void;
}) {
  const reviewIds = [...buckets.due, ...buckets.fresh].map((row) => row.id);
  const total = reviewIds.length + buckets.later.length;
  if (total === 0) return null;
  return (
    <section className="card-buckets" aria-label="Card buckets">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        icon="mdi-play"
        disabled={reviewIds.length === 0}
        onClick={() => onReview(reviewIds)}
      >
        {`Review ${buckets.due.length} due`}
        {buckets.fresh.length > 0 ? ` · ${buckets.fresh.length} new` : ""}
      </Button>
      <Pill className="card-buckets__pill" text={`${buckets.fresh.length} fresh`} />
      <Pill className="card-buckets__pill" text={`${buckets.later.length} later`} />
    </section>
  );
}
