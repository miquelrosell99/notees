/**
 * Regression test: reloading a deep link (`/<workspace>/<node-uuid>`) must
 * open that node, not leave the app on the home view.
 *
 * Root cause: under React StrictMode the one-time route-processing effect is
 * mounted, cleaned up, and re-mounted. The cleanup cancelled the in-flight
 * async route resolution, while the `lastRouteRef` guard blocked the second
 * mount from re-processing the same route — so the URL's node was never
 * opened and the workspace stayed on its default (home) view.
 */
import { StrictMode, type MutableRefObject } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { useRouteAdapter } from '../useRouteAdapter';
import { WorkspaceStoreProvider } from '@/core/hooks/WorkspaceStoreProvider';
import { MemoryRelay, MemoryTransport } from '@/core/transport';
import {
  getOrCreateWorkspaceStoreClient,
  closeWorkspaceStoreClient,
} from '@/core/adapters/workspaceStoreClientAdapter';
import { closeWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { useAuthStore, useNavigationStore } from '@/stores';
import { workspaceKeys } from '@/hooks/queryKeys';
import { uuidv7 } from '@/core/uuid';

interface HarnessProps {
  hasInitialized: MutableRefObject<boolean>;
  isProcessingUrl: MutableRefObject<boolean>;
}

function Harness({ hasInitialized, isProcessingUrl }: HarnessProps) {
  useRouteAdapter({ hasInitialized, isProcessingUrl });
  return null;
}

describe('useRouteAdapter deep-link reload under StrictMode', () => {
  afterEach(() => {
    useNavigationStore.setState({
      currentNodeUuid: null,
      currentPropertyUuid: null,
      mainViewType: 'node',
    });
    useAuthStore.setState({ user: null, isAuthenticated: false, authVerified: false });
  });

  it('opens the node from the URL on a fresh mount (reload)', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const transport = new MemoryTransport(new MemoryRelay(), workspaceId);
    const nodeUuid = uuidv7();

    // Seed the workspace store with the node the URL points at.
    const client = await getOrCreateWorkspaceStoreClient(workspaceId, actorId, transport);
    await client.mutate('createNode', [
      { nodeId: nodeUuid, kind: 'page', parentId: null, classIds: [] },
    ]);
    expect(await client.query('getNodeByUuid', [nodeUuid])).toBeDefined();

    // Pre-cache the workspace list the way AuthenticatedShell leaves it before
    // Layout mounts, so the adapter's guard passes on the very first render.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(workspaceKeys.all, {
      items: [{ uuid: workspaceId, name: 'Test WS', is_active: true }],
    });

    useAuthStore.setState({ user: null, isAuthenticated: true, authVerified: true });

    const hasInitialized: MutableRefObject<boolean> = { current: false };
    const isProcessingUrl: MutableRefObject<boolean> = { current: false };

    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <WorkspaceStoreProvider actorId={actorId} transport={transport}>
            <MemoryRouter initialEntries={[`/${workspaceId}/${nodeUuid}`]}>
              <Routes>
                <Route
                  path="/:workspaceId/*"
                  element={<Harness hasInitialized={hasInitialized} isProcessingUrl={isProcessingUrl} />}
                />
              </Routes>
            </MemoryRouter>
          </WorkspaceStoreProvider>
        </QueryClientProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(hasInitialized.current).toBe(true), { timeout: 5000 });
    expect(useNavigationStore.getState().currentNodeUuid).toBe(nodeUuid);

    await closeWorkspaceStoreClient(workspaceId);
    await closeWorkspaceStore(workspaceId).catch(() => undefined);
  }, 15000);
});
