import type { Operation } from './types/operation';

export type ConflictType = 'move_move' | 'node_deleted' | 'class_conflict' | 'property_conflict';

export interface SyncConflictInput {
  /** The node that both sides mutated. */
  nodeUuid: string;
  /** High-level conflict category. */
  conflictType: ConflictType;
  /** Local operation ids involved in the conflict. */
  localOperationIds: string[];
  /** Remote operation ids involved in the conflict. */
  remoteOperationIds: string[];
}

function getNodeId(op: Operation): string | undefined {
  const payload = op.payload as Record<string, unknown> | undefined;
  return typeof payload?.nodeId === 'string' ? payload.nodeId : undefined;
}

function getClassId(op: Operation): string | undefined {
  const payload = op.payload as Record<string, unknown> | undefined;
  return typeof payload?.classId === 'string' ? payload.classId : undefined;
}

function getNewParentId(op: Operation): string | null | undefined {
  const payload = op.payload as Record<string, unknown> | undefined;
  return payload?.newParentId as string | null | undefined;
}

function getPropertyKey(op: Operation): string | undefined {
  const payload = op.payload as Record<string, unknown> | undefined;
  if (typeof payload?.nodeId !== 'string' || typeof payload?.schemaId !== 'string') return undefined;
  const index = typeof payload.index === 'number' ? payload.index : 0;
  return `${payload.nodeId}:${payload.schemaId}:${index}`;
}

const DELETE_OPS = new Set(['node.delete', 'node.archive', 'node.permanentDelete']);
const CLASS_OPS = new Set(['class.assign', 'class.unassign']);

function isNodeMutation(op: Operation): boolean {
  switch (op.envelope.opType) {
    case 'node.move':
    case 'node.updateContent':
    case 'node.convert':
    case 'property.set':
    case 'property.unset':
    case 'class.assign':
    case 'class.unassign':
      return true;
    default:
      return false;
  }
}

/**
 * Detect semantic conflicts between a batch of just-applied remote operations
 * and the local pending (not yet server-acknowledged) operations.
 *
 * CRDT-aware edits such as concurrent text updates are intentionally not
 * surfaced as conflicts; the CRDT merge is authoritative. This function flags
 * operations that violate structural invariants or where user intent is
 * ambiguous (e.g. two users move the same node to different parents, or one
 * user deletes a node while another edits it).
 */
export function detectConflicts(
  remoteOps: readonly Operation[],
  localOps: readonly Operation[]
): SyncConflictInput[] {
  const conflicts: SyncConflictInput[] = [];
  const byNode = new Map<string, { remote: Operation[]; local: Operation[] }>();

  const bucket = (op: Operation, side: 'remote' | 'local') => {
    const nodeId = getNodeId(op);
    if (!nodeId) return;
    let entry = byNode.get(nodeId);
    if (!entry) {
      entry = { remote: [], local: [] };
      byNode.set(nodeId, entry);
    }
    entry[side].push(op);
  };

  for (const op of remoteOps) bucket(op, 'remote');
  for (const op of localOps) bucket(op, 'local');

  for (const [nodeId, { remote, local }] of byNode) {
    const remoteMoves = remote.filter((op) => op.envelope.opType === 'node.move');
    const localMoves = local.filter((op) => op.envelope.opType === 'node.move');
    const remoteDeletes = remote.filter((op) => DELETE_OPS.has(op.envelope.opType));
    const localDeletes = local.filter((op) => DELETE_OPS.has(op.envelope.opType));
    const remoteClassOps = remote.filter((op) => CLASS_OPS.has(op.envelope.opType));
    const localClassOps = local.filter((op) => CLASS_OPS.has(op.envelope.opType));

    // Move/move conflict: same node moved to different parents.
    for (const r of remoteMoves) {
      for (const l of localMoves) {
        if (getNewParentId(r) !== getNewParentId(l)) {
          conflicts.push({
            nodeUuid: nodeId,
            conflictType: 'move_move',
            localOperationIds: [l.envelope.id],
            remoteOperationIds: [r.envelope.id],
          });
        }
      }
    }

    // Delete/edit conflict: one side deleted/archived/permanently-deleted the
    // node while the other side mutated it.
    if (remoteDeletes.length > 0 && local.some(isNodeMutation)) {
      conflicts.push({
        nodeUuid: nodeId,
        conflictType: 'node_deleted',
        localOperationIds: local.filter(isNodeMutation).map((op) => op.envelope.id),
        remoteOperationIds: remoteDeletes.map((op) => op.envelope.id),
      });
    }
    if (localDeletes.length > 0 && remote.some(isNodeMutation)) {
      conflicts.push({
        nodeUuid: nodeId,
        conflictType: 'node_deleted',
        localOperationIds: localDeletes.map((op) => op.envelope.id),
        remoteOperationIds: remote.filter(isNodeMutation).map((op) => op.envelope.id),
      });
    }

    // Class assign/unassign conflict: same class assigned and unassigned
    // concurrently on the same node.
    for (const r of remoteClassOps) {
      for (const l of localClassOps) {
        if (getClassId(r) === getClassId(l) && r.envelope.opType !== l.envelope.opType) {
          conflicts.push({
            nodeUuid: nodeId,
            conflictType: 'class_conflict',
            localOperationIds: [l.envelope.id],
            remoteOperationIds: [r.envelope.id],
          });
        }
      }
    }
  }

  // Property set/unset conflict: same property instance changed in opposite
  // directions concurrently. LWW will eventually pick a winner, but the user's
  // intent is ambiguous.
  const remoteProps = remoteOps.filter((op) =>
    ['property.set', 'property.unset'].includes(op.envelope.opType)
  );
  const localProps = localOps.filter((op) =>
    ['property.set', 'property.unset'].includes(op.envelope.opType)
  );
  for (const r of remoteProps) {
    for (const l of localProps) {
      if (getPropertyKey(r) === getPropertyKey(l) && r.envelope.opType !== l.envelope.opType) {
        const nodeId = getNodeId(r);
        if (!nodeId) continue;
        conflicts.push({
          nodeUuid: nodeId,
          conflictType: 'property_conflict',
          localOperationIds: [l.envelope.id],
          remoteOperationIds: [r.envelope.id],
        });
      }
    }
  }

  return conflicts;
}
