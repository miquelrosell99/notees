import { describe, it, expect, beforeAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { WorkspaceStoreProvider } from '../WorkspaceStoreProvider';
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

describe('useWorkspaceStore', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('opens a store and repeated calls return the same instance', async () => {
    const props = await createProviderProps();
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
