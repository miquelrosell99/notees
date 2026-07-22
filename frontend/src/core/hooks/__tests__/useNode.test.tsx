import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { WorkspaceStoreProvider } from '../WorkspaceStoreProvider';
import { useNode } from '../useNode';
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

describe('useNode', () => {
  it('reads a node that exists in the store', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);

    const nodeId = uuidv7();
    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), { wrapper: Wrapper });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());

    act(() => {
      storeResult.current.store!.createNode({ nodeId, kind: 'page', parentId: null });
    });

    const { result } = renderHook(() => useNode('ws-test', nodeId), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.node).toBeDefined();
    expect(result.current.node!.id).toBe(nodeId);
    expect(result.current.node!.kind).toBe('page');
  });

  it('returns undefined for a missing node', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);

    const nodeId = uuidv7();
    const { result } = renderHook(() => useNode('ws-test', nodeId), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.node).toBeUndefined();
  });
});
