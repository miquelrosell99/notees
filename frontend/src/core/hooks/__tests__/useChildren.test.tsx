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
  it('updates both old and new parent subscribers when a child is moved', async () => {
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

    const { result: childrenA } = renderHook(() => useChildren('ws-test', parentA), { wrapper: Wrapper });
    const { result: childrenB } = renderHook(() => useChildren('ws-test', parentB), { wrapper: Wrapper });

    await waitFor(() => expect(childrenA.current.children).toContain(childId));
    expect(childrenB.current.children).not.toContain(childId);

    act(() => {
      store.moveNode(childId, parentB);
    });

    await waitFor(() => expect(childrenA.current.children).not.toContain(childId));
    await waitFor(() => expect(childrenB.current.children).toContain(childId));
  });
});
