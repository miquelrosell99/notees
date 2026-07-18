import { describe, it, expect, beforeAll } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { webcrypto } from 'node:crypto';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WorkspaceStoreProvider } from '../WorkspaceStoreProvider';
import { useWorkspaceStore } from '../useWorkspaceStore';
import { useProperty, useProperties, useSetProperty } from '../';
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
  return function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/ws-test']}>
          <Routes>
            <Route
              path="/:workspaceId/*"
              element={
                <WorkspaceStoreProvider
                  actorId={props.actorId}
                  cryptoKey={props.key}
                  transport={props.transport}
                >
                  {children}
                </WorkspaceStoreProvider>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('useProperty', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('reads a property value after it is set through the store', async () => {
    const props = await createProviderProps();
    const Wrapper = wrapper(props);
    const nodeId = uuidv7();
    const schemaId = uuidv7();

    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());
    const store = storeResult.current.store!;

    act(() => {
      store.createNode({ nodeId, kind: 'page', parentId: null });
      store.setProperty({
        propertyValueId: uuidv7(),
        nodeId,
        schemaId,
        value: 'hello sqlite',
      });
    });

    const { result } = renderHook(() => useProperty({ nodeId, schemaId }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.value).toBe('hello sqlite');
  });

  it('aggregates all property values for a node', async () => {
    const props = await createProviderProps();
    const Wrapper = wrapper(props);
    const nodeId = uuidv7();
    const schemaA = uuidv7();
    const schemaB = uuidv7();

    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());
    const store = storeResult.current.store!;

    act(() => {
      store.createNode({ nodeId, kind: 'page', parentId: null });
      store.setProperty({
        propertyValueId: uuidv7(),
        nodeId,
        schemaId: schemaA,
        value: 'value-a',
      });
      store.setProperty({
        propertyValueId: uuidv7(),
        nodeId,
        schemaId: schemaB,
        value: 'value-b',
      });
    });

    const { result } = renderHook(() => useProperties(nodeId), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.properties[schemaA]).toBeDefined());
    expect(result.current.properties[schemaA][0]).toBe('value-a');
    expect(result.current.properties[schemaB][0]).toBe('value-b');
  });

  it('sets a property value through useSetProperty', async () => {
    const props = await createProviderProps();
    const Wrapper = wrapper(props);
    const nodeId = uuidv7();
    const schemaId = uuidv7();

    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());
    const store = storeResult.current.store!;

    act(() => {
      store.createNode({ nodeId, kind: 'page', parentId: null });
    });

    const { result: setResult } = renderHook(() => useSetProperty(), { wrapper: Wrapper });
    await waitFor(() => expect(setResult.current.isPending).toBe(false));

    await act(async () => {
      await setResult.current.mutateAsync({ nodeId, schemaId, value: 'from hook' });
    });

    const row = store.getProperty({ nodeId, schemaId });
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toBe('from hook');

    const { result } = renderHook(() => useProperty({ nodeId, schemaId }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.value).toBe('from hook'));
  });
});
