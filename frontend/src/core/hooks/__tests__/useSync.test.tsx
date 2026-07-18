import { describe, it, expect, beforeAll } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { WorkspaceStoreProvider } from '../WorkspaceStoreProvider';
import { useSync } from '../useSync';
import { useWorkspaceStore } from '../useWorkspaceStore';
import { MemoryRelay, MemoryTransport } from '../../transport';
import { deriveKey } from '../../crypto';
import { uuidv7 } from '../../uuid';

async function createProviderProps(workspaceId: string) {
  const actorId = uuidv7();
  const key = await deriveKey('test-password');
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, workspaceId);
  return { actorId, key, transport, relay };
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

describe('useSync', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('pushes and pulls operations through MemoryTransport', async () => {
    const workspaceId = uuidv7();
    const propsA = await createProviderProps(workspaceId);
    const propsB = await createProviderProps(workspaceId);
    const WrapperA = wrapper(propsA);
    const WrapperB = wrapper(propsB);

    const nodeId = uuidv7();

    // Open store A and create a node.
    const { result: storeA } = renderHook(() => useWorkspaceStore(workspaceId), { wrapper: WrapperA });
    await waitFor(() => expect(storeA.current.store).toBeDefined());
    act(() => {
      storeA.current.store!.createNode({ nodeId, kind: 'page', parentId: null });
    });

    // Open store B and sync it.
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
