/**
 * useRouteAdapter — read the current react-router route and sync it into
 * navigationStore.
 *
 * This replaces the old useRouterSync hook. The route tells the store what
 * the current view should be, and the rest of the app continues to render
 * from the store.
 *
 * NOTE: processRoute() is async because it validates UUIDs against the API.
 * To avoid the stale-closure race that used to live in useNavigationUrlSync,
 * each invocation increments a generation counter; only the most recent
 * generation is allowed to update the store or clear the isProcessingUrl flag.
 */
import { useEffect, useCallback, useRef, useContext, type MutableRefObject } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigationStore, useSettingsStore, useAuthStore, useFavoritesStore, useRecentsStore, type MainViewType, type DefaultView } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useTodayNote } from '@/features/content';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { listWorkspaces, switchWorkspace } from '@/features/workspace';
import { WorkspaceStoreContext } from '@/core/hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { getNodeByUuid } from '@/core/query/nodeByUuid';
import { getPropertySchemaByUuid } from '@/core/query/propertySchema';
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

        useFavoritesStore.getState().clearFavorites();
        useRecentsStore.getState().clearRecents();
        queryClient.clear();

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
    useNavigationStore.setState({ currentNodeUuid: null, mainViewType: 'node' });
  }, []);

  const ctx = useContext(WorkspaceStoreContext);

  const processRoute = useCallback(async () => {
    if (!workspaceId || isLoadingDbs || !dbData || !ctx) return;

    const generation = ++routeGenerationRef.current;
    const isLatestGeneration = () => generation === routeGenerationRef.current;

    isProcessingUrl.current = true;
    try {
      await ensureWorkspace(workspaceId);

      if (!isLatestGeneration()) return;

      const store = await getOrCreateWorkspaceStore(
        workspaceId,
        ctx.actorId,
        ctx.transport,
      );
      if (!isLatestGeneration()) return;

      if (!entityUuid) {
        // Workspace root: honour the user's "Default view" setting.
        if (defaultView === 'today') {
          if (todayNote) {
            openNode(todayNote.uuid);
          }
          // If today's note is still loading, this effect will re-run once it resolves.
        } else {
          setMainViewType(DEFAULT_VIEW_TO_MAIN_VIEW[defaultView]);
        }
        return;
      }

      const rest = entityUuid.toLowerCase();

      if (SPECIAL_VIEWS[rest] && SPECIAL_VIEWS[rest] !== 'auth') {
        log.debug('Route: special view', { viewType: SPECIAL_VIEWS[rest] });
        setMainViewType(SPECIAL_VIEWS[rest] as MainViewType);
        return;
      }

      if (isUuid(entityUuid)) {
        const uuid = entityUuid;
        const isDateUuid = isDayUuid(uuid) || isMonthUuid(uuid) || isYearUuid(uuid);

        // Pages/nodes are the common case; try them first to avoid spurious
        // property 404s on every page navigation.
        const node = getNodeByUuid(store, uuid);
        if (node) {
          if (!isLatestGeneration()) return;
          log.debug('UUID resolved to node', { uuid, id: node.uuid, is_page: node.is_page });
          openNode(node.uuid);
          return;
        }
        if (!isLatestGeneration()) return;

        if (!isDateUuid) {
          const property = getPropertySchemaByUuid(store, uuid);
          if (!isLatestGeneration()) return;
          if (property) {
            log.debug('UUID resolved to property', { uuid, id: property.uuid });
            openPropertyView(property.uuid);
            return;
          }
        }

        log.warn('UUID not found as node or property, going home', { uuid });
        useNavigationStore.setState({ currentNodeUuid: null, currentPropertyUuid: null });
        goHome();
        return;
      }

      log.warn('Unknown route segment, going home', { segment: entityUuid });
      goHome();
    } finally {
      if (isLatestGeneration()) {
        isProcessingUrl.current = false;
      }
      hasInitialized.current = true;
    }
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
    defaultView,
    todayNote,
  ]);

  // Process the route whenever the workspace or entity segment changes.
  useEffect(() => {
    processRoute();
  }, [processRoute]);

  // Keep navigationHistoryStore in sync with browser history length on first init.
  useEffect(() => {
    if (hasInitialized.current) {
      useNavigationHistoryStore.getState().reset();
    }
  }, [hasInitialized]);
}
