/**
 * SyncManagerV2 409-requeue cap tests.
 *
 * A permanently conflicting operation (e.g. a create whose parent no longer
 * exists server-side) was requeued on every 409 with no attempt cap, so it
 * rejected every subsequent batch forever and silently blocked the whole
 * outbox. The requeue path must respect MAX_RETRIES like the generic error
 * path does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { getOperationRuntime, setOperationRuntime, OperationRuntime } from '@/runtime';
import type { Operation } from '@/runtime';
import { localSyncEngine } from './engine/localSyncEngine';
import { SyncManagerV2 } from './SyncManagerV2';
import { syncBatchV2 } from './api/syncV2';
import type * as SyncV2Api from './api/syncV2';

vi.mock('./api/syncV2', async (importOriginal) => {
  const actual = await importOriginal<typeof SyncV2Api>();
  return { ...actual, syncBatchV2: vi.fn() };
});

vi.mock('@/features/workspace', () => ({
  useWorkspaces: () => ({ data: null }),
}));

vi.mock('@/hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => true,
}));

const conflict409 = {
  response: {
    status: 409,
    data: {
      detail: { stale_nodes: [], server_vectors: {}, conflict_type: 'text_edit' },
    },
  },
};

function makeAddClassOp(id: string, blockId: string): Operation {
  return {
    id,
    type: 'add_class',
    blockId,
    state: 'pending',
    dependsOn: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { classId: 'class-1' },
  } as Operation;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

/** Seed the outbox with an op that has already failed `attempts` times. */
async function seedOutbox(op: Operation, attempts: number) {
  getOperationRuntime().applyOperation(op);
  await localSyncEngine.stageOperations([op]);
  for (let i = 0; i < attempts; i += 1) {
    await localSyncEngine.fail(op.id, 'previous 409', null);
  }
}

describe('SyncManagerV2 409 requeue cap', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    setOperationRuntime(new OperationRuntime());
    await localSyncEngine.clear();
    vi.mocked(syncBatchV2).mockRejectedValue(conflict409);
  });

  afterEach(async () => {
    await localSyncEngine.clear();
    setOperationRuntime(null);
  });

  it('drops an op that has exhausted MAX_RETRIES on repeated 409 conflicts', async () => {
    // MAX_RETRIES is 6; with 5 recorded attempts the next 409 is the last one.
    const op = makeAddClassOp('op-exhausted', 'block-x');
    await seedOutbox(op, 5);

    render(createElement(SyncManagerV2, { workspaceUuid: 'ws-1', clientId: 'client-1' }), { wrapper });

    await waitFor(() => {
      expect(localSyncEngine.getPendingEntries()).toHaveLength(0);
    });
    const runtimeOp = getOperationRuntime().getOperations().find((o) => o.id === op.id);
    expect(runtimeOp?.state).toBe('failed');
  });

  it('requeues an op with remaining attempts instead of dropping it', async () => {
    const op = makeAddClassOp('op-retry', 'block-y');
    await seedOutbox(op, 0);

    render(createElement(SyncManagerV2, { workspaceUuid: 'ws-1', clientId: 'client-1' }), { wrapper });

    await waitFor(() => {
      const entry = localSyncEngine.getPendingEntries().find((e) => e.op.id === op.id);
      expect(entry?.attemptCount).toBeGreaterThan(0);
    });
    expect(localSyncEngine.getPendingEntries()).toHaveLength(1);
    const runtimeOp = getOperationRuntime().getOperations().find((o) => o.id === op.id);
    expect(runtimeOp?.state).not.toBe('failed');
  });
});
