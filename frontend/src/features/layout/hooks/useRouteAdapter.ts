/**
 * useRouteAdapter — read the current react-router route and sync it into
 * navigationStore.
 *
 * This replaces the old useRouterSync hook. It preserves the existing tab model:
 * the route tells the store what the active tab should be, and the rest of the
 * app continues to render from the store.
 *
 * NOTE: processRoute() is async because it validates UUIDs against the API.
 * To avoid the stale-closure race that used to live in useNavigationUrlSync,
 * each invocation increments a generation counter; only the most recent
 * generation is allowed to update the store or clear the isProcessingUrl flag.
 */
import { useEffect, useCallback, useRef, type MutableRefObject } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigationStore, useSettingsStore, useAuthStore, type MainViewType, type DefaultView } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useTodayNote } from '@/features/content';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { listWorkspaces, switchWorkspace } from '@/features/workspace';
import { getNodeByUuid } from '@/api/nodes';
import { getPropertyByUuid } from '@/api/properties';
import { SPECIAL_VIEWS, parseSplitParams } from './url';
import { isUuid } from '@/utils/uuid';
import { favoriteKeys, recentKeys, workspaceKeys } from '@/hooks/queryKeys';
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
  // Monotonic generation counters for in-flight async route-to-store lookups.
  // They guard against stale async results when the URL or search params change
  // while a previous lookup is still pending.
  const routeGenerationRef = useRef(0);
  const splitGenerationRef = useRef(0);

  const params = useParams();
  const workspaceId = params.workspaceId;
  const entityUuid = params['*'];
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const authVerified = useAuthStore((s) => s.authVerified);

  const {
    setMainViewType,
    openNode,
    openPropertyView,
    openNodeInNewTab,
  } = useNavigationStore(
    useShallow((s) => ({
      setMainViewType: s.setMainViewType,
      openNode: s.openNode,
      openPropertyView: s.openPropertyView,
      openNodeInNewTab: s.openNodeInNewTab,
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

        queryClient.removeQueries({ queryKey: favoriteKeys.all });
        queryClient.removeQueries({ queryKey: recentKeys.all });
        queryClient.clear();

        await queryClient.fetchQuery({
          queryKey: workspaceKeys.all,
          queryFn: () => listWorkspaces(),
        });

        queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
        queryClient.invalidateQueries({ queryKey: recentKeys.all });
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

  const processRoute = useCallback(async () => {
    if (!workspaceId || isLoadingDbs || !dbData) return;

    const generation = ++routeGenerationRef.current;
    const isLatestGeneration = () => generation === routeGenerationRef.current;

    isProcessingUrl.current = true;
    try {
      await ensureWorkspace(workspaceId);

      if (!isLatestGeneration()) return;

      if (!entityUuid) {
        // Workspace root: honour the user's "Default view" setting. This uses
        // the normal tab-opening paths, so a tab is created when the tab list is
        // empty and the URL syncs just like any other navigation.
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
        try {
          const node = await getNodeByUuid(uuid);
          if (!isLatestGeneration()) return;
          log.debug('UUID resolved to node', { uuid, id: node.uuid, is_page: node.is_page });
          openNode(node.uuid);
          return;
        } catch {
          if (!isLatestGeneration()) return;
          /* not a node */
        }

        if (!isDateUuid) {
          try {
            const property = await getPropertyByUuid(uuid);
            if (!isLatestGeneration()) return;
            log.debug('UUID resolved to property', { uuid, id: property.uuid });
            openPropertyView(property.uuid);
            return;
          } catch {
            if (!isLatestGeneration()) return;
            /* not a property either */
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

  // Handle split-pane query params independently.
  useEffect(() => {
    if (!hasInitialized.current || !dbData) return;

    const { splitUuid, splitOrientation } = parseSplitParams(searchParams.toString());

    if (!splitUuid || !splitOrientation) {
      useNavigationStore.setState({ secondaryTabId: null, splitOrientation: null });
      return;
    }

    const generation = ++splitGenerationRef.current;
    const isLatestGeneration = () => generation === splitGenerationRef.current;

    const resolveSplit = async () => {
      try {
        const node = await getNodeByUuid(splitUuid);
        if (!isLatestGeneration()) return;
        openNodeInNewTab(node.uuid);
        const state = useNavigationStore.getState();
        const newTab = state.tabs[state.tabs.length - 1];
        if (newTab) {
          useNavigationStore.setState({
            activeTabId: state.tabs[0]?.id ?? newTab.id,
            secondaryTabId: newTab.id,
            splitOrientation,
          });
        }
      } catch {
        if (!isLatestGeneration()) return;
        log.warn('Split UUID not found, ignoring split', { uuid: splitUuid });
      }
    };

    resolveSplit();
  }, [searchParams, dbData, openNodeInNewTab, hasInitialized]);

  // Keep navigationHistoryStore in sync with browser history length on first init.
  useEffect(() => {
    if (hasInitialized.current) {
      useNavigationHistoryStore.getState().reset();
    }
  }, [hasInitialized]);
}
