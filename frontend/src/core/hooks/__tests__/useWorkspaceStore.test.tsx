import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { WorkspaceStoreProvider } from '../WorkspaceStoreProvider';
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

describe('useWorkspaceStore', () => {
  it('opens a store and repeated calls return the same instance', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);

    const { result: resultA } = renderHook(() => useWorkspaceStore('ws-test'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(resultA.current.store).toBeDefined());
    const storeA = resultA.current.store;

    const { result: resultB } = renderHook(() => useWorkspaceStore('ws-test'), { wrapper: Wrapper });
    await waitFor(() => expect(resultB.current.store).toBeDefined());

    expect(resultB.current.store).toBe(storeA);
    expect(resultA.current.error).toBeNull();
    expect(resultB.current.error).toBeNull();
  });
});
