/**
 * SyncManagerV2 — batch adapter between OperationRuntime and POST /sync/batch.
 *
 * Implements dual-vector state:
 * - acked_vector: last vectors confirmed by the server (persisted in LocalSyncEngine)
 * - pending_vector: acked_vector + optimistic local increments (derived at send time)
 *
 * Mounted by App when the active workspace uses sync protocol v2.
 */

import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getOperationRuntime, type Operation } from '@/runtime';
import { isValidServerNodeId } from '@/runtime/graphHelpers';
import { liveSyncManager } from '@/features/collab';
import { nodeKeys } from '@/hooks/queryKeys';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useConnectionStore } from '@/stores/connectionStore';
import type { Node } from '@/types/api';
import { localSyncEngine } from './engine/localSyncEngine';
import { operationToIntentV2, syncBatchV2, type BaseVector, type VersionVector } from './api/syncV2';
import { useSyncStatusStore } from './stores/syncStatusStore';
import { useConflictStore, type ConflictType } from './stores/conflictStore';
import { graphNodeToConflictNode } from './utils/graphNodeToConflictNode';
import { getNode as fetchNode } from '@/api/nodes';
import { useLivePresenceStore } from '@/features/collab';
import { useWorkspaces } from '@/features/workspace';
import { generateUUID } from '@/utils/uuid';

const BATCH_INTERVAL_MS = 200;
const MAX_BATCH_SIZE = 50;
const MAX_RETRIES = 6; // immediate + 5 delayed attempts, then hold
const RETRY_DELAYS_MS = [0, 5000, 15000, 60000, 300000, 1800000];

function computeRetryDelay(attemptCount: number): number {
  return RETRY_DELAYS_MS[Math.min(attemptCount, RETRY_DELAYS_MS.length - 1)];
}

function isBehind(serverVec: VersionVector, clientVec: VersionVector): boolean {
  for (const [clientId, serverSeq] of Object.entries(serverVec)) {
    const clientSeq = clientVec[clientId] ?? 0;
    if (serverSeq > clientSeq) return true;
  }
  return false;
}

function generateClientId(): string {
  let id = localStorage.getItem('notees-client-id');
  if (!id) {
    id = generateUUID();
    localStorage.setItem('notees-client-id', id);
  }
  return id;
}

interface SyncManagerV2Props {
  workspaceUuid?: string;
  clientId?: string;
}

export function SyncManagerV2({ workspaceUuid: workspaceUuidProp, clientId: clientIdProp }: SyncManagerV2Props): null {
  const { data: workspacesData } = useWorkspaces({ enabled: true });
  const activeWorkspace = useMemo(() => {
    if (!workspacesData?.items) return null;
    return workspacesData.items.find((ws) => ws.is_active) ?? workspacesData.items[0] ?? null;
  }, [workspacesData]);

  const workspaceUuid = workspaceUuidProp ?? activeWorkspace?.uuid ?? null;
  const clientId = useMemo(() => clientIdProp ?? generateClientId(), [clientIdProp]);

  const queryClient = useQueryClient();
  const runtime = getOperationRuntime();
  const isOnline = useOnlineStatus();
  const backendHealthy = useConnectionStore((s) => s.healthy);
  const setQueue = useSyncStatusStore((s) => s.setQueue);
  const setStatus = useSyncStatusStore((s) => s.setStatus);

  const ackedVectorRef = useRef<BaseVector>({});
  const inFlightRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isProcessingRef = useRef<boolean>(false);

  const canDispatch = isOnline && backendHealthy !== false && workspaceUuid != null;

  const updateStatus = useCallback(() => {
    const entries = localSyncEngine.getPendingEntries();
    const hasFailed = entries.some((e) => e.attemptCount > 0);
    setQueue(entries);
    if (!canDispatch && entries.length > 0 && !hasFailed) {
      setStatus('offline');
    }
  }, [canDispatch, setQueue, setStatus]);

  const updateAckedVector = useCallback((vectors: BaseVector) => {
    ackedVectorRef.current = mergeVectors(ackedVectorRef.current, vectors);
    localSyncEngine.setAckedVector(ackedVectorRef.current);
  }, []);

  const flushBatch = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (isProcessingRef.current) return;
    if (!canDispatch) {
      updateStatus();
      return;
    }

    const now = Date.now();
    const pendingOps = new Map<string, Operation>();
    for (const op of runtime.getDispatchableOperations()) {
      if (!inFlightRef.current.has(op.id)) {
        pendingOps.set(op.id, op);
      }
    }

    // Match runtime pending ops with outbox entries, respecting retry backoff.
    const batch: Operation[] = [];
    for (const entry of localSyncEngine.getPendingEntries()) {
      if (batch.length >= MAX_BATCH_SIZE) break;
      const op = pendingOps.get(entry.op.id);
      if (!op) continue;
      if (entry.nextRetryAt && entry.nextRetryAt > now) continue;
      batch.push(op);
    }

    if (batch.length === 0) {
      updateStatus();
      return;
    }

    isProcessingRef.current = true;
    for (const op of batch) {
      inFlightRef.current.add(op.id);
    }

    const LOCAL_ONLY_OP_TYPES: ReadonlySet<Operation['type']> = new Set(['set_collapsed']);

    const classified = batch.map((op) => {
      if (LOCAL_ONLY_OP_TYPES.has(op.type)) {
        return { op, kind: 'local-only' as const };
      }
      const intent = operationToIntentV2(op, clientId, localSyncEngine.consumeSeq());
      if (intent === null) {
        return { op, kind: 'unsupported' as const };
      }
      return { op, kind: 'send' as const, intent };
    });

    const intents = classified
      .filter((c): c is { op: Operation; kind: 'send'; intent: NonNullable<typeof classified[number]['intent']> } => c.kind === 'send')
      .map((c) => c.intent);

    const baseVector: BaseVector = {};
    for (const op of batch) {
      baseVector[op.blockId] = ackedVectorRef.current[op.blockId] ?? {};
      // The server validates vectors for the target node and its parent for
      // create/move operations. Include the parent in the base vector so the
      // server can confirm the client has seen the latest parent state.
      if (op.type === 'create' || op.type === 'move' || op.type === 'move_node') {
        const payload = op.payload as { parentId?: string | null };
        if (payload.parentId) {
          baseVector[payload.parentId] = ackedVectorRef.current[payload.parentId] ?? {};
        }
      }
    }

    try {
      const response = await syncBatchV2({
        ops: intents,
        base_vector: baseVector,
        workspace_uuid: workspaceUuid,
      });

      updateAckedVector(response.new_vectors);
      for (const c of classified) {
        if (c.kind === 'send' || c.kind === 'local-only') {
          runtime.acknowledgeOperation(c.op.id);
          await localSyncEngine.acknowledge(c.op.id);
        } else {
          runtime.failOperation(c.op.id, 'Unsupported sync v2 operation');
          await localSyncEngine.remove(c.op.id);
        }
      }
    } catch (error) {
      const axiosError = error as { response?: { status?: number; data?: { detail?: unknown } } } | undefined;
      if (axiosError?.response?.status === 409) {
        const conflict = axiosError.response.data?.detail as
          | { stale_nodes?: string[]; server_vectors?: BaseVector; conflict_type?: string }
          | undefined;
        const staleNodes = conflict?.stale_nodes ?? [];
        const serverVectors = conflict?.server_vectors ?? {};
        updateAckedVector(serverVectors);

        const conflictType = (conflict?.conflict_type ?? 'text_edit') as ConflictType;
        for (const nodeUuid of staleNodes) {
          // Skip IDs that cannot be real server nodes (ghost/virtual/pseudo UUIDs).
          // These surface when the client generated an operation against an invalid
          // parent; fetching them would always 404.
          if (!isValidServerNodeId(nodeUuid)) {
            if (process.env.NODE_ENV === 'development') {
              console.warn('[SyncManagerV2] Skipping conflict fetch for invalid node UUID:', nodeUuid);
            }
            continue;
          }

          const baseNode = queryClient.getQueryData<Node>(nodeKeys.detail(nodeUuid)) ?? null;
          const ourGraphNode = runtime.getNode(nodeUuid);
          const ourNode = ourGraphNode ? graphNodeToConflictNode(ourGraphNode) : null;

          await queryClient.invalidateQueries({ queryKey: nodeKeys.detail(nodeUuid) });
          let theirNode: Node | null = null;
          try {
            theirNode = await queryClient.fetchQuery<Node>({
              queryKey: nodeKeys.detail(nodeUuid),
              queryFn: () => fetchNode(nodeUuid),
              staleTime: 0,
            });
          } catch (fetchError) {
            const status = (fetchError as { response?: { status?: number } } | undefined)?.response?.status;
            if (process.env.NODE_ENV === 'development') {
              console.warn(`[SyncManagerV2] Conflict fetch failed for ${nodeUuid} (status ${status ?? 'unknown'}):`, fetchError);
            }
            // Node was deleted server-side; leave theirNode null so the conflict
            // is recorded without crashing the sync loop.
          }

          const sentOpIds = classified
            .filter((c) => c.kind === 'send')
            .map((c) => c.op.id);
          useConflictStore.getState().addConflict({
            workspaceUuid,
            nodeUuid,
            conflictType,
            baseNode,
            ourNode,
            theirNode,
            operationIds: sentOpIds,
            createdAt: Date.now(),
          });
          useLivePresenceStore.getState().setConflict(nodeUuid, nodeUuid, {
            reason: '409_conflict',
          });
        }

        const sentOps = classified.filter((c) => c.kind === 'send').map((c) => c.op);
        const staleSet = new Set(staleNodes);
        const requeue: Operation[] = [];
        for (const op of sentOps) {
          const serverVec = serverVectors[op.blockId] ?? {};
          const clientVec = ackedVectorRef.current[op.blockId] ?? {};
          const ownBlockStale = staleSet.has(op.blockId);
          const ownBlockDeleted = ownBlockStale && conflict?.conflict_type === 'node_deleted';
          const genuineConflict = ownBlockStale && isBehind(serverVec, clientVec);
          // Requeue unless the op's own block was deleted server-side or there is
          // a genuine vector conflict on the op's own block. Create ops always
          // requeue because their target does not exist on the server yet; the
          // conflict is on a referenced node (parent/anchor) and resolves once the
          // client vectors catch up.
          if (op.type === 'create' || (!ownBlockDeleted && !genuineConflict)) {
            requeue.push(op);
          } else {
            runtime.failOperation(
              op.id,
              `Conflict: ${conflict?.conflict_type ?? 'unknown'} on ${op.blockId}`,
            );
            await localSyncEngine.remove(op.id);
          }
        }
        for (const op of requeue) {
          const entry = localSyncEngine.getEntry(op.id);
          const nextAttempt = (entry?.attemptCount ?? 0) + 1;
          const delay = computeRetryDelay(nextAttempt);
          await localSyncEngine.fail(op.id, '409 conflict', Date.now() + delay);
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const sentOps = classified.filter((c) => c.kind === 'send').map((c) => c.op);
        for (const op of sentOps) {
          const entry = localSyncEngine.getEntry(op.id);
          const nextAttempt = (entry?.attemptCount ?? 0) + 1;
          if (nextAttempt >= MAX_RETRIES) {
            runtime.failOperation(op.id, message);
            await localSyncEngine.fail(op.id, message, null);
          } else {
            const delay = computeRetryDelay(nextAttempt);
            await localSyncEngine.fail(op.id, message, Date.now() + delay);
          }
        }
      }
    } finally {
      for (const op of batch) {
        inFlightRef.current.delete(op.id);
      }
      isProcessingRef.current = false;
      updateStatus();
      const remaining = runtime
        .getDispatchableOperations()
        .filter((op) => !inFlightRef.current.has(op.id)).length;
      if (remaining > 0 && !timerRef.current) {
        timerRef.current = setTimeout(() => {
          void flushBatch();
        }, BATCH_INTERVAL_MS);
      }
    }
  }, [canDispatch, clientId, queryClient, runtime, updateAckedVector, updateStatus, workspaceUuid]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      await localSyncEngine.init();
      if (!mounted) return;
      ackedVectorRef.current = localSyncEngine.getAckedVector();

      // Re-apply any persisted ops that are not already in the runtime.
      const runtimeOpIds = new Set(runtime.getOperations().map((o) => o.id));
      for (const entry of localSyncEngine.getPendingEntries()) {
        if (!runtimeOpIds.has(entry.op.id)) {
          runtime.applyOperation(entry.op);
        }
      }
      updateStatus();
      void flushBatch();
    })();

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      void localSyncEngine.flush();
      if (localSyncEngine.getPendingEntries().length > 0) {
        // Standard cross-browser way to show a "Leave site? Changes may not be saved" warning.
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    const unsubscribe = runtime.subscribe(() => {
      const hasDispatchable = runtime.getDispatchableOperations().some(
        (op) => !inFlightRef.current.has(op.id)
      );
      if (!hasDispatchable) return;
      updateStatus();
      if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          void flushBatch();
        }, BATCH_INTERVAL_MS);
      }
    });

    const unsubscribeLive = liveSyncManager.onMessage((msg) => {
      if (msg.type === 'ops_applied') {
        for (const raw of msg.ops) {
          const op = raw as Record<string, string> | undefined;
          const nodeUuid = op?.node_uuid;
          if (nodeUuid) {
            queryClient.invalidateQueries({ queryKey: nodeKeys.detail(nodeUuid) });
          }
        }
      }
    });

    const handleBackgroundSync = () => {
      if (mounted && canDispatch && workspaceUuid) {
        void flushBatch();
      }
    };
    window.addEventListener('notees:background-sync', handleBackgroundSync);

    return () => {
      mounted = false;
      unsubscribe();
      unsubscribeLive();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('notees:background-sync', handleBackgroundSync);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      void localSyncEngine.flush();
    };
  }, [flushBatch, queryClient, runtime, updateStatus, canDispatch, workspaceUuid]);

  // Resume dispatch when connectivity returns.
  useEffect(() => {
    if (canDispatch && localSyncEngine.getPendingEntries().length > 0) {
      void flushBatch();
    }
  }, [canDispatch, flushBatch]);

  return null;
}

function mergeVectors(a: BaseVector, b: BaseVector): BaseVector {
  const result: BaseVector = { ...a };
  for (const [nodeUuid, vec] of Object.entries(b)) {
    const merged: VersionVector = { ...(result[nodeUuid] ?? {}) };
    for (const [clientId, seq] of Object.entries(vec)) {
      merged[clientId] = Math.max(merged[clientId] ?? 0, seq);
    }
    result[nodeUuid] = merged;
  }
  return result;
}
