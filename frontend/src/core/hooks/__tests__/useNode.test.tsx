import { describe, it, expect, beforeAll } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { WorkspaceStoreProvider } from '../WorkspaceStoreProvider';
import { useNode } from '../useNode';
import { useWorkspaceStore } from '../useWorkspaceStore';
import { MemoryRelay, MemoryTransport } from '../../transport';
import { deriveKey } from '../../crypto';
import { uuidv7 } from '../../uuid';

async function createProviderProps() {
  const actorId = uuidv7();
  const key = await deriveKey('test-password');
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, 'ws-test');
  return { actorId, key, transport };
}

function wrapper(props: { actorId: string; key: CryptoKey; transport: MemoryTransport }) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <WorkspaceStoreProvider actorId={props.actorId} cryptoKey={props.key} transport={props.transport}>
        {children}
      </WorkspaceStoreProvider>
    );
  };
}

describe('useNode', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('re-renders when a node is created via the store', async () => {
    const props = await createProviderProps();
    const Wrapper = wrapper(props);

    const nodeId = uuidv7();
    const { result } = renderHook(() => useNode('ws-test', nodeId), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.node).toBeUndefined();

    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), { wrapper: Wrapper });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());

    act(() => {
      storeResult.current.store!.createNode({ nodeId, kind: 'page', parentId: null });
    });

    await waitFor(() => expect(result.current.node).toBeDefined());
    expect(result.current.node!.id).toBe(nodeId);
    expect(result.current.node!.kind).toBe('page');
  });
});
