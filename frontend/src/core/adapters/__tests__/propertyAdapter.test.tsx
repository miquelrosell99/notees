import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WorkspaceStoreProvider } from '../../hooks/WorkspaceStoreProvider';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { MemoryRelay, MemoryTransport } from '../../transport';
import { uuidv7 } from '../../uuid';
import {
  usePropertiesAdapter,
  usePropertyAdapter,
  useBatchPropertyValuesAdapter,
  useSetNodePropertyAdapter,
} from '@/core/adapters';

vi.mock('@/core/utils/featureFlags', () => ({
  ENABLE_SQLITE_STORE: true,
}));

function createProviderProps() {
  const actorId = uuidv7();
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, 'ws-test');
  return { actorId, transport };
}

function sqliteWrapper(props: { actorId: string; transport: MemoryTransport }) {
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

describe('propertyAdapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('usePropertiesAdapter derives schemas from property_schema rows', async () => {
    const props = createProviderProps();
    const Wrapper = sqliteWrapper(props);
    const schemaId = uuidv7();

    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());
    const store = storeResult.current.store!;

    act(() => {
      store.createPropertySchema({ schemaId, name: 'Test Property', type: 'text' });
    });

    const { result } = renderHook(() => usePropertiesAdapter(), { wrapper: Wrapper });
    await waitFor(() =>
      expect(result.current.data?.some((s) => s.uuid === schemaId)).toBe(true)
    );
  });

  it('usePropertyAdapter returns a derived schema by UUID', async () => {
    const props = createProviderProps();
    const Wrapper = sqliteWrapper(props);
    const schemaId = uuidv7();

    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());
    const store = storeResult.current.store!;

    act(() => {
      store.createPropertySchema({ schemaId, name: 'Named Property', type: 'text' });
    });

    const { result } = renderHook(() => usePropertyAdapter(schemaId), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.uuid).toBe(schemaId);
  });

  it('useBatchPropertyValuesAdapter returns property values for nodes', async () => {
    const props = createProviderProps();
    const Wrapper = sqliteWrapper(props);
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
        value: 'batch value',
      });
    });

    const { result } = renderHook(() => useBatchPropertyValuesAdapter([nodeId]), {
      wrapper: Wrapper,
    });
    await waitFor(() =>
      expect(result.current.data?.[nodeId]?.[schemaId]).toBe('batch value')
    );
  });

  it('useSetNodePropertyAdapter writes a value through the SQLite store', async () => {
    const props = createProviderProps();
    const Wrapper = sqliteWrapper(props);
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

    const { result } = renderHook(() => useSetNodePropertyAdapter(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    await act(async () => {
      await result.current.mutateAsync({
        nodeUuid: nodeId,
        propertyId: schemaId,
        value: 'adapter value',
      });
    });

    const row = store.getProperty({ nodeId, schemaId });
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toBe('adapter value');
  });
});
