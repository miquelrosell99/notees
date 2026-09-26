/**
 * Semantic conflict detection — port of v1 `frontend/src/core/syncConflicts.ts`
 * to v2 envelopes and the M1 op registry.
 *
 * v2 op mapping (the M1 registry has no class.assign op):
 *  - move_move: two `object.move` ops on the same objectId targeting
 *    different parents concurrently — parent/position converge by row-level
 *    LWW (envelope HLC), but the user's intent is ambiguous (v1: two
 *    concurrent re-parents). object.move landed 2026-09-26; the detector
 *    below still keys move_move off `object.create` envelopes carrying an
 *    explicit parentId (the legacy reparent carrier for in-flight logs — a
 *    create re-issued on an existing id is now a strict no-op in the store).
 *  - node_deleted: `object.delete` on one side vs a node mutation on the other.
 *    Mutations: `object.update`, `property.set`, `property.unset`, and a create
 *    carrying parentId (a reparent).
 *  - class_conflict: concurrent `object.create` on the same node seeding
 *    different classIds — the OR-Set unions them, but the user's intent is
 *    ambiguous (v1: assign vs unassign of the same class concurrently).
 *  - property_conflict: `property.set` vs `property.unset` on the same
 *    (objectId, propertySchemaId, idx) — LWW picks a winner, intent is ambiguous.
 *
 * CRDT-aware edits (concurrent text merges, set-vs-set LWW) are deliberately
 * NOT conflicts; the merge is authoritative. Reporting never blocks apply.
 */

import type { Envelope } from "@notees/protocol";

export type ConflictType = "move_move" | "node_deleted" | "class_conflict" | "property_conflict";

export interface SyncConflict {
  /** The node both sides mutated. */
  nodeId: string;
  conflictType: ConflictType;
  localEnvelopeIds: string[];
  remoteEnvelopeIds: string[];
}

function payloadOf(envelope: Envelope): Record<string, unknown> {
  return envelope.payload as Record<string, unknown>;
}

/** v2 payloads key the node as objectId (v1 used nodeId — kept as fallback). */
function getNodeId(envelope: Envelope): string | undefined {
  const payload = payloadOf(envelope);
  if (typeof payload.objectId === "string") return payload.objectId;
  return typeof payload.nodeId === "string" ? payload.nodeId : undefined;
}

function getParentId(envelope: Envelope): string | null | undefined {
  return payloadOf(envelope).parentId as string | null | undefined;
}

function getClassIds(envelope: Envelope): string[] {
  const value = payloadOf(envelope).classIds;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function getPropertyKey(envelope: Envelope): string | undefined {
  const payload = payloadOf(envelope);
  const nodeId = getNodeId(envelope);
  if (!nodeId || typeof payload.propertySchemaId !== "string") return undefined;
  const idx = typeof payload.idx === "number" ? payload.idx : 0;
  return `${nodeId}:${payload.propertySchemaId}:${idx}`;
}

const DELETE_OPS = new Set(["object.delete"]);
const MUTATION_OPS = new Set(["object.update", "property.set", "property.unset"]);

/** A create carrying an explicit parentId on an existing node is a reparent. */
function isReparentCreate(envelope: Envelope): boolean {
  return envelope.opType === "object.create" && getParentId(envelope) != null;
}

function isNodeMutation(envelope: Envelope): boolean {
  return MUTATION_OPS.has(envelope.opType) || isReparentCreate(envelope);
}

export function detectConflicts(
  remoteEnvelopes: readonly Envelope[],
  localEnvelopes: readonly Envelope[],
): SyncConflict[] {
  const conflicts: SyncConflict[] = [];
  const byNode = new Map<string, { remote: Envelope[]; local: Envelope[] }>();

  const bucket = (envelope: Envelope, side: "remote" | "local") => {
    const nodeId = getNodeId(envelope);
    if (!nodeId) return;
    let entry = byNode.get(nodeId);
    if (!entry) {
      entry = { remote: [], local: [] };
      byNode.set(nodeId, entry);
    }
    entry[side].push(envelope);
  };

  for (const envelope of remoteEnvelopes) bucket(envelope, "remote");
  for (const envelope of localEnvelopes) bucket(envelope, "local");

  for (const [nodeId, { remote, local }] of byNode) {
    const remoteCreates = remote.filter((env) => env.opType === "object.create");
    const localCreates = local.filter((env) => env.opType === "object.create");
    const remoteDeletes = remote.filter((env) => DELETE_OPS.has(env.opType));
    const localDeletes = local.filter((env) => DELETE_OPS.has(env.opType));

    // Move/move: same node reparented to different parents concurrently.
    for (const r of remoteCreates) {
      for (const l of localCreates) {
        const rParent = getParentId(r);
        const lParent = getParentId(l);
        if (rParent != null && lParent != null && rParent !== lParent) {
          conflicts.push({
            nodeId,
            conflictType: "move_move",
            localEnvelopeIds: [l.id],
            remoteEnvelopeIds: [r.id],
          });
        }
      }
    }

    // Delete/edit: one side deleted the node while the other mutated it.
    if (remoteDeletes.length > 0 && local.some(isNodeMutation)) {
      conflicts.push({
        nodeId,
        conflictType: "node_deleted",
        localEnvelopeIds: local.filter(isNodeMutation).map((env) => env.id),
        remoteEnvelopeIds: remoteDeletes.map((env) => env.id),
      });
    }
    if (localDeletes.length > 0 && remote.some(isNodeMutation)) {
      conflicts.push({
        nodeId,
        conflictType: "node_deleted",
        localEnvelopeIds: localDeletes.map((env) => env.id),
        remoteEnvelopeIds: remote.filter(isNodeMutation).map((env) => env.id),
      });
    }

    // Class conflict: concurrent creates seeding different class sets.
    for (const r of remoteCreates) {
      for (const l of localCreates) {
        const rClasses = new Set(getClassIds(r));
        const lClasses = new Set(getClassIds(l));
        const symmetricDiff =
          [...rClasses].some((c) => !lClasses.has(c)) || [...lClasses].some((c) => !rClasses.has(c));
        if (symmetricDiff) {
          conflicts.push({
            nodeId,
            conflictType: "class_conflict",
            localEnvelopeIds: [l.id],
            remoteEnvelopeIds: [r.id],
          });
        }
      }
    }
  }

  // Property set/unset conflict: same slot changed in opposite directions.
  const remoteProps = remoteEnvelopes.filter((env) =>
    ["property.set", "property.unset"].includes(env.opType),
  );
  const localProps = localEnvelopes.filter((env) =>
    ["property.set", "property.unset"].includes(env.opType),
  );
  for (const r of remoteProps) {
    for (const l of localProps) {
      const rKey = getPropertyKey(r);
      if (rKey === undefined || rKey !== getPropertyKey(l)) continue;
      if (r.opType === l.opType) continue;
      const nodeId = getNodeId(r);
      if (!nodeId) continue;
      conflicts.push({
        nodeId,
        conflictType: "property_conflict",
        localEnvelopeIds: [l.id],
        remoteEnvelopeIds: [r.id],
      });
    }
  }

  return conflicts;
}
