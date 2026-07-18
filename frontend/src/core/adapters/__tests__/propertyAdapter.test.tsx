import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { type ReactNode } from 'react';
import { webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WorkspaceStoreProvider } from '../../hooks/WorkspaceStoreProvider';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { deriveKey } from '../../crypto';
import { MemoryRelay, MemoryTransport } from '../../transport';
import { uuidv7 } from '../../uuid';
import * as propertiesApi from '@/api/properties';
import * as nodesApi from '@/api/nodes';
import type { Property } from '@/types/api';
import {
  usePropertiesAdapter,
  usePropertyAdapter,
  useBatchPropertyValuesAdapter,
  useSetNodePropertyAdapter,
} from '@/core/adapters';

let mockEnableSqliteStore = false;

vi.mock('@/core/utils/featureFlags', () => ({
  get ENABLE_SQLITE_STORE() {
    return mockEnableSqliteStore;
  },
}));

async function createProviderProps() {
  const actorId = uuidv7();
  const key = await deriveKey('test-password');
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, 'ws-test');
  return { actorId, key, transport };
}

function sqliteWrapper(props: { actorId: string; key: CryptoKey; transport: MemoryTransport }) {
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

function legacyWrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/ws-test']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('propertyAdapter', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockEnableSqliteStore = false;
  });

  describe('when ENABLE_SQLITE_STORE is true', () => {
    beforeEach(() => {
      mockEnableSqliteStore = true;
    });

    it('usePropertiesAdapter derives schemas from property_value rows', async () => {
      const props = await createProviderProps();
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
          value: 'sqlite value',
        });
      });

      const { result } = renderHook(() => usePropertiesAdapter(), { wrapper: Wrapper });
      await waitFor(() =>
        expect(result.current.data?.some((s) => s.uuid === schemaId)).toBe(true)
      );
    });

    it('usePropertyAdapter returns a derived schema by UUID', async () => {
      const props = await createProviderProps();
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
          value: 'x',
        });
      });

      const { result } = renderHook(() => usePropertyAdapter(schemaId), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data!.uuid).toBe(schemaId);
    });

    it('useBatchPropertyValuesAdapter returns property values for nodes', async () => {
      const props = await createProviderProps();
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
      const props = await createProviderProps();
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

  describe('when ENABLE_SQLITE_STORE is false', () => {
    it('usePropertiesAdapter delegates to the legacy hook', async () => {
      mockEnableSqliteStore = false;
      const property: Property = {
        uuid: 'legacy-prop-uuid',
        name: 'Legacy Property',
        icon: null,
        type: 'text',
        multi: false,
        is_system: false,
        scope: 'global',
        node_uuid: null,
        icon_visibility: 'hidden',
        validation_rules: null,
        required: false,
        readonly: false,
        hide_when_empty: false,
        default_value: null,
        create_date: new Date().toISOString(),
        write_date: new Date().toISOString(),
        class_filter_uuids: [],
        options: [],
      };
      vi.spyOn(propertiesApi, 'listProperties').mockResolvedValue([property]);

      const { result } = renderHook(() => usePropertiesAdapter(), { wrapper: legacyWrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([property]);
    });

    it('useBatchPropertyValuesAdapter delegates to the legacy hook', async () => {
      mockEnableSqliteStore = false;
      const batchResult = { 'node-a': { 'prop-a': 'value-a' } };
      vi.spyOn(nodesApi, 'batchGetPropertyValues').mockResolvedValue(batchResult);

      const { result } = renderHook(() => useBatchPropertyValuesAdapter(['node-a']), {
        wrapper: legacyWrapper,
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(batchResult);
    });
  });
});
