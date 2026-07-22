import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { WorkspaceStoreProvider } from '../WorkspaceStoreProvider';
import { useSync } from '../useSync';
import { useWorkspaceStore } from '../useWorkspaceStore';
import { MemoryRelay, MemoryTransport } from '../../transport';
import { uuidv7 } from '../../uuid';

function createProviderProps(workspaceId: string, relay?: MemoryRelay) {
  const actorId = uuidv7();
  const sharedRelay = relay ?? new MemoryRelay();
  const transport = new MemoryTransport(sharedRelay, workspaceId);
  return { actorId, transport, relay: sharedRelay };
}

function wrapper(props: { actorId: string; transport: MemoryTransport }) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <WorkspaceStoreProvider actorId={props.actorId} transport={props.transport}>
        {children}
      </WorkspaceStoreProvider>
    );
  };
}

describe('useSync', () => {
  it('pushes and pulls operations through MemoryTransport', async () => {
    const workspaceId = uuidv7();
    const relay = new MemoryRelay();
    const propsA = createProviderProps(workspaceId, relay);
    const propsB = createProviderProps(workspaceId, relay);
    const WrapperA = wrapper(propsA);
    const WrapperB = wrapper(propsB);

    const nodeId = uuidv7();

    // Open store A, create a node, and push it to the shared relay.
    const { result: storeA } = renderHook(() => useWorkspaceStore(workspaceId), { wrapper: WrapperA });
    await waitFor(() => expect(storeA.current.store).toBeDefined());

    const { result: syncA } = renderHook(() => useSync(workspaceId), { wrapper: WrapperA });
    await waitFor(() => expect(syncA.current.status).toBe('idle'));

    act(() => {
      storeA.current.store!.createNode({ nodeId, kind: 'page', parentId: null });
    });

    await act(async () => {
      await syncA.current.sync();
    });

    // Open store B (different actor, fresh local DB) and pull from the relay.
    const { result: storeB } = renderHook(() => useWorkspaceStore(workspaceId), { wrapper: WrapperB });
    await waitFor(() => expect(storeB.current.store).toBeDefined());

    const { result: syncB } = renderHook(() => useSync(workspaceId), { wrapper: WrapperB });
    await waitFor(() => expect(syncB.current.status).toBe('idle'));

    await act(async () => {
      await syncB.current.sync();
    });

    const nodeB = storeB.current.store!.getNode(nodeId);
    expect(nodeB).toBeDefined();
    expect(nodeB!.id).toBe(nodeId);
    expect(syncB.current.status).toBe('idle');
  });
});
