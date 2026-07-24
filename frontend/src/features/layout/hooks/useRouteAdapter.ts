/**
 * useRouteAdapter — read the current react-router route and sync it into
 * navigationStore.
 *
 * This replaces the old useRouterSync hook. The route tells the store what
 * the current view should be, and the rest of the app continues to render
 * from the store.
 *
 * The adapter is split into two effects:
 * 1. One-time route-param processing (workspace switch + entity lookup).
 *    It is gated by the last processed route so it does not re-run when
 *    unrelated state (e.g. `todayNote`) changes.
 * 2. Reactive view selection for the workspace root, which depends only on
 *    `defaultView` and `todayNote`.
 *
 * To avoid the stale-closure race that used to live in useNavigationUrlSync,
 * each async invocation increments a generation counter; only the most recent
 * generation is allowed to update the store or clear the isProcessingUrl flag.
 */
import { useEffect, useCallback, useRef, useContext, useState, type MutableRefObject } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import type { Property } from '@/types/api';
import { useNavigationStore, useSettingsStore, useAuthStore, useRecentsStore, type MainViewType, type DefaultView } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useTodayNote } from '@/features/content';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { listWorkspaces, switchWorkspace } from '@/features/workspace';
import { invalidateWorkspaceQueries } from '@/lib/queryClient';
import { WorkspaceStoreContext } from '@/core/hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import { SPECIAL_VIEWS } from './url';
import { isUuid } from '@/utils/uuid';
import { workspaceKeys } from '@/hooks/queryKeys';
import { getLogger } from '@/utils/logger';
import { isDayUuid, isMonthUuid, isYearUuid } from '@/utils/dateUuid';

const log = getLogger('RouteAdapter');

const DEFAULT_VIEW_TO_MAIN_VIEW: Record<Exclude<DefaultView, 'today'>, MainViewType> = {
  journal: 'journals',
  'all-pages': 'pages',
  graph: 'graph',
};

interface RouteAdapterRefs {
  hasInitialized: MutableRefObject<boolean>;
  isProcessingUrl: MutableRefObject<boolean>;
}

export function useRouteAdapter({ hasInitialized, isProcessingUrl }: RouteAdapterRefs) {
  // Monotonic generation counter for in-flight async route-to-store lookups.
  // It guards against stale async results when the URL changes while a previous
  // lookup is still pending.
  const routeGenerationRef = useRef(0);
  const lastRouteRef = useRef<{ workspaceId?: string; entityUuid?: string | null }>({});
  const [routeReady, setRouteReady] = useState(false);

  const params = useParams();
  const workspaceId = params.workspaceId;
  const entityUuid = params['*'];
  const queryClient = useQueryClient();
  const authVerified = useAuthStore((s) => s.authVerified);

  const {
    setMainViewType,
    openNode,
    openPropertyView,
  } = useNavigationStore(
    useShallow((s) => ({
      setMainViewType: s.setMainViewType,
      openNode: s.openNode,
      openPropertyView: s.openPropertyView,
    }))
  );

  const defaultView = useSettingsStore((s) => s.defaultView);
  const { data: todayNote } = useTodayNote();

  const { data: dbData, isLoading: isLoadingDbs } = useQuery({
    queryKey: workspaceKeys.all,
    queryFn: () => listWorkspaces(),
    enabled: authVerified,
    staleTime: 30000,
    select: (data) => ({
      workspaces: data.items,
      active: data.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });

  const ensureWorkspace = useCallback(
    async (targetWsUuid: string): Promise<boolean> => {
      if (!dbData) return false;
      if (dbData.active === targetWsUuid) return false;

      const ws = dbData.workspaces.find((w) => w.uuid === targetWsUuid);
      if (!ws) {
        log.warn('Workspace not found or no access', { targetWsUuid });
        return false;
      }

      log.info('Auto-switching workspace for URL', { from: dbData.active, to: targetWsUuid });
      useNavigationStore.setState({ isSwitchingWorkspace: true });
      try {
        await switchWorkspace(targetWsUuid);

        useNavigationStore.setState({
          currentNodeUuid: null,
          activeNodeUuid: null,
          sidebarNode: null,
          localGraphNodeUuid: null,
          mainViewType: 'node',
        });

        useRecentsStore.getState().clearRecents();
        invalidateWorkspaceQueries(queryClient);

        await queryClient.fetchQuery({
          queryKey: workspaceKeys.all,
          queryFn: () => listWorkspaces(),
        });

        return true;
      } finally {
        useNavigationStore.setState({ isSwitchingWorkspace: false });
      }
    },
    [dbData, queryClient]
  );

  const goHome = useCallback(() => {
    log.debug('Going to home');
    const state = useNavigationStore.getState();
    if (state.currentNodeUuid !== null || state.mainViewType !== 'node') {
      useNavigationStore.setState({ currentNodeUuid: null, mainViewType: 'node' });
    }
  }, []);

  const ctx = useContext(WorkspaceStoreContext);

  // One-time route-param processing: switch workspace and resolve the entity
  // segment. Gated by the last processed route so it does not re-run when
  // `todayNote`, `defaultView`, or other reactive state changes.
  useEffect(() => {
    if (!workspaceId || isLoadingDbs || !dbData || !ctx) return;

    const sameRoute =
      lastRouteRef.current.workspaceId === workspaceId &&
      lastRouteRef.current.entityUuid === entityUuid;
    if (sameRoute) return;

    lastRouteRef.current = { workspaceId, entityUuid };
    const generation = ++routeGenerationRef.current;
    const isLatestGeneration = () => generation === routeGenerationRef.current;
    let cancelled = false;

    isProcessingUrl.current = true;

    const processRoute = async (): Promise<void> => {
      try {
        await ensureWorkspace(workspaceId);
        if (cancelled || !isLatestGeneration()) return;

        // Workspace root view selection is handled by the reactive effect below
        // because it depends on `defaultView` and `todayNote`.
        if (!entityUuid) return;

        const client = await getOrCreateWorkspaceStoreClient(
          workspaceId,
          ctx.actorId,
          ctx.transport,
        );
        if (cancelled || !isLatestGeneration()) return;

        const rest = entityUuid.toLowerCase();

        if (SPECIAL_VIEWS[rest] && SPECIAL_VIEWS[rest] !== 'auth') {
          const targetView = SPECIAL_VIEWS[rest] as MainViewType;
          log.debug('Route: special view', { viewType: targetView });
          if (useNavigationStore.getState().mainViewType !== targetView) {
            setMainViewType(targetView);
          }
          return;
        }

        if (isUuid(entityUuid)) {
          const uuid = entityUuid;
          const isDateUuid = isDayUuid(uuid) || isMonthUuid(uuid) || isYearUuid(uuid);

          // Pages/nodes are the common case; try them first to avoid spurious
          // property 404s on every page navigation.
          const node = await client.query<Node | undefined>('getNodeByUuid', [uuid]);
          if (node) {
            if (cancelled || !isLatestGeneration()) return;
            log.debug('UUID resolved to node', { uuid, id: node.uuid, is_page: node.is_page });
            const state = useNavigationStore.getState();
            if (state.currentNodeUuid !== node.uuid || state.mainViewType !== 'node') {
              openNode(node.uuid);
            }
            return;
          }
          if (cancelled || !isLatestGeneration()) return;

          if (!isDateUuid) {
            const property = await client.query<Property | undefined>('getPropertySchemaByUuid', [uuid]);
            if (cancelled || !isLatestGeneration()) return;
            if (property) {
              log.debug('UUID resolved to property', { uuid, id: property.uuid });
              const state = useNavigationStore.getState();
              if (state.currentPropertyUuid !== property.uuid || state.mainViewType !== 'property') {
                openPropertyView(property.uuid);
              }
              return;
            }
          }

          log.warn('UUID not found as node or property, going home', { uuid });
          const missingState = useNavigationStore.getState();
          if (missingState.currentNodeUuid !== null || missingState.currentPropertyUuid !== null) {
            useNavigationStore.setState({ currentNodeUuid: null, currentPropertyUuid: null });
          }
          goHome();
          return;
        }

        log.warn('Unknown route segment, going home', { segment: entityUuid });
        goHome();
      } finally {
        if (isLatestGeneration()) {
          isProcessingUrl.current = false;
          hasInitialized.current = true;
          if (!routeReady) {
            setRouteReady(true);
          }
        }
      }
    };

    void processRoute();

    return () => {
      cancelled = true;
      if (isLatestGeneration()) {
        isProcessingUrl.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaceId,
    entityUuid,
    isLoadingDbs,
    dbData,
    ctx,
    ensureWorkspace,
    goHome,
    setMainViewType,
    openNode,
    openPropertyView,
    hasInitialized,
    isProcessingUrl,
  ]);

  // Reactive effect for the workspace root: honour the user's default view.
  // This intentionally re-runs when `defaultView` or `todayNote` resolves.
  useEffect(() => {
    if (!hasInitialized.current || !workspaceId || entityUuid) return;

    if (defaultView === 'today') {
      if (todayNote) {
        const state = useNavigationStore.getState();
        if (state.currentNodeUuid !== todayNote.uuid || state.mainViewType !== 'node') {
          openNode(todayNote.uuid);
        }
      }
    } else {
      const targetView = DEFAULT_VIEW_TO_MAIN_VIEW[defaultView];
      if (useNavigationStore.getState().mainViewType !== targetView) {
        setMainViewType(targetView);
      }
    }
  }, [workspaceId, entityUuid, defaultView, todayNote, openNode, setMainViewType, hasInitialized]);

  // Keep navigationHistoryStore in sync with browser history length on first init.
  useEffect(() => {
    if (routeReady) {
      useNavigationHistoryStore.getState().reset();
    }
  }, [routeReady]);
}
