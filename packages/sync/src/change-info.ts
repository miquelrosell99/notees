/**
 * Batch change-info: the incremental-invalidation vocabulary shared by the
 * SyncEngine (which sees applied batches) and the embedding client (which
 * expands ancestors and notifies subscribers).
 *
 * The web client's read cache refetches cached reads on every
 * worker notification; carrying WHAT changed lets it refetch only impacted
 * keys instead of the whole cache. Two axes are enough:
 *
 *  - affectedNodeIds: the envelope-carried node ids a batch touched. A
 *    content-only edit of node X invalidates reads scoped to X or its
 *    ancestors (a page tree read of P contains X iff P is an ancestor of X);
 *    the client expands the ancestor chain before notifying.
 *  - structural: op types that can change listings/membership/placement
 *    (create/delete/move/class/tag/schema/feature ops). The UI cannot scope
 *    those cheaply, so the client conservatively invalidates everything.
 */

/** Op types whose apply can change listings, membership, or placement. */
const LISTING_AFFECTING_OPS: ReadonlySet<string> = new Set([
  "object.create",
  "object.delete",
  "object.move",
  "class.create",
  "class.update",
  "class.delete",
  "class.setExtends",
  "class.property.set",
  "class.property.unset",
  "class.reorder",
  "class.unassign",
  "propertySchema.create",
  "propertySchema.update",
  "propertySchema.delete",
  "workspace.feature.set",
]);

/** True when the op type can change what listing-style reads return. */
export function isListingAffectingOp(opType: string): boolean {
  return LISTING_AFFECTING_OPS.has(opType);
}

/**
 * Envelope-level classification: like isListingAffectingOp, but also catches
 * `object.update` carriers whose payload toggles presentAsMain — that moves a
 * node in/out of the page listings even though the op type is the content
 * carrier. (Store ChangeSummaries do not carry the payload, so the remote
 * path classifies off the envelopes instead.)
 */
export function isListingAffectingEnvelope(envelope: {
  opType: string;
  payload?: unknown;
}): boolean {
  if (isListingAffectingOp(envelope.opType)) return true;
  return (
    envelope.opType === "object.update" &&
    typeof envelope.payload === "object" &&
    envelope.payload !== null &&
    "presentAsMain" in envelope.payload
  );
}

/**
 * Per-batch summary for incremental UI invalidation. `affectedNodeIds` is
 * flat and deduped but NOT ancestor-expanded (the embedding client owns the
 * store and does that at notify time).
 */
export interface BatchChangeInfo {
  affectedNodeIds: string[];
  structural: boolean;
}

/**
 * Summarize raw envelopes. `affectedNodeIds` here is the ENVELOPE-carried
 * (authored) metadata — the store's per-apply ChangeSummary is authoritative
 * when available (summarizeAppliedChanges); use this only where summaries
 * do not exist (the client's remote-batch wrapper).
 */
export function summarizeEnvelopes(
  envelopes: ReadonlyArray<{ opType: string; affectedNodeIds: string[]; payload?: unknown }>,
): BatchChangeInfo {
  const affected = new Set<string>();
  let structural = false;
  for (const envelope of envelopes) {
    if (isListingAffectingEnvelope(envelope)) structural = true;
    for (const id of envelope.affectedNodeIds) affected.add(id);
  }
  return { affectedNodeIds: [...affected], structural };
}

/**
 * Summarize an applied batch from the store's ChangeSummaries (1:1 with the
 * applied envelopes) zipped with the envelopes themselves: the structural
 * check needs the envelope (op type + payload — presentAsMain rides
 * object.update), while the affected ids come from the summary the applier
 * computed (envelope-carried metadata can be incomplete).
 */
export function summarizeAppliedChanges(
  entries: ReadonlyArray<{
    envelope: { opType: string; payload?: unknown };
    summary: { affectedNodeIds: string[]; ignored: boolean };
  }>,
): BatchChangeInfo {
  const affected = new Set<string>();
  let structural = false;
  for (const { envelope, summary } of entries) {
    if (summary.ignored === true) continue;
    if (isListingAffectingEnvelope(envelope)) structural = true;
    for (const id of summary.affectedNodeIds) affected.add(id);
  }
  return { affectedNodeIds: [...affected], structural };
}

/** Merge change-infos from coalesced notifications: union of ids, OR of structural. */
export function mergeChangeInfo(
  a: BatchChangeInfo | undefined,
  b: BatchChangeInfo,
): BatchChangeInfo {
  if (a === undefined) return { affectedNodeIds: [...b.affectedNodeIds], structural: b.structural };
  const affected = new Set(a.affectedNodeIds);
  for (const id of b.affectedNodeIds) affected.add(id);
  return { affectedNodeIds: [...affected], structural: a.structural || b.structural };
}
