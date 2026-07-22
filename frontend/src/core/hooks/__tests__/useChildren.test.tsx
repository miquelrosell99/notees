import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { WorkspaceStoreProvider } from '../WorkspaceStoreProvider';
import { useChildren } from '../useChildren';
import { useWorkspaceStore } from '../useWorkspaceStore';
import { MemoryRelay, MemoryTransport } from '../../transport';
import { uuidv7 } from '../../uuid';

function createProviderProps() {
  const actorId = uuidv7();
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, 'ws-test');
  return { actorId, transport };
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

describe('useChildren', () => {
  it('reads the children for a parent', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);

    const parentId = uuidv7();
    const childId = uuidv7();

    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), { wrapper: Wrapper });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());
    const store = storeResult.current.store!;

    act(() => {
      store.createNode({ nodeId: parentId, kind: 'page', parentId: null });
      store.createNode({ nodeId: childId, kind: 'block', parentId: null });
      store.moveNode(childId, parentId);
    });

    const { result } = renderHook(() => useChildren('ws-test', parentId), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.children).toContain(childId));
  });

  it('reflects a moved child on fresh read', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);

    const parentA = uuidv7();
    const parentB = uuidv7();
    const childId = uuidv7();

    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), { wrapper: Wrapper });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());
    const store = storeResult.current.store!;

    act(() => {
      store.createNode({ nodeId: parentA, kind: 'page', parentId: null });
      store.createNode({ nodeId: parentB, kind: 'page', parentId: null });
      store.createNode({ nodeId: childId, kind: 'block', parentId: null });
      store.moveNode(childId, parentA);
    });

    act(() => {
      store.moveNode(childId, parentB);
    });

    const { result: childrenA } = renderHook(() => useChildren('ws-test', parentA), { wrapper: Wrapper });
    const { result: childrenB } = renderHook(() => useChildren('ws-test', parentB), { wrapper: Wrapper });

    await waitFor(() => expect(childrenA.current.children).not.toContain(childId));
    await waitFor(() => expect(childrenB.current.children).toContain(childId));
  });
});
