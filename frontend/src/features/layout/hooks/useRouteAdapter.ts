/**
 * useRouteAdapter — read the current react-router route and sync it into
 * navigationStore.
 *
 * This replaces the old useRouterSync hook. It preserves the existing tab model:
 * the route tells the store what the active tab should be, and the rest of the
 * app continues to render from the store.
 */
import { useEffect, useCallback, type MutableRefObject } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigationStore, type MainViewType } from '@/stores';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { listWorkspaces, switchWorkspace } from '@/features/workspace/api/workspaces';
import { getNodeByUuid } from '@/api/nodes';
import { getPropertyByUuid } from '@/api/properties';
import { SPECIAL_VIEWS, parseSplitParams } from './url';
import { isUuid } from '@/utils/uuid';
import { favoriteKeys, recentKeys } from '@/hooks/queryKeys';
import { getLogger } from '@/utils/logger';
import { isDayUuid, isMonthUuid, isYearUuid } from '@/utils/dateUuid';

const log = getLogger('RouteAdapter');

interface RouteAdapterRefs {
  hasInitialized: MutableRefObject<boolean>;
  isProcessingUrl: MutableRefObject<boolean>;
}

export function useRouteAdapter({ hasInitialized, isProcessingUrl }: RouteAdapterRefs) {
  const { workspaceId, entityUuid } = useParams<{ workspaceId?: string; entityUuid?: string }>();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const {
    setMainViewType,
    openNode,
    openPropertyView,
    openNodeInNewTab,
  } = useNavigationStore();

  const { data: dbData, isLoading: isLoadingDbs } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
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
      await switchWorkspace(targetWsUuid);

      useNavigationStore.setState({
        currentNodeId: null,
        activeNodeId: null,
        sidebarNode: null,
        localGraphNodeId: null,
        mainViewType: 'node',
      });

      queryClient.removeQueries({ queryKey: favoriteKeys.all });
      queryClient.removeQueries({ queryKey: recentKeys.all });
      queryClient.clear();

      await queryClient.fetchQuery({
        queryKey: ['workspaces'],
        queryFn: () => listWorkspaces(),
      });

      queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
      queryClient.invalidateQueries({ queryKey: recentKeys.all });
      return true;
    },
    [dbData, queryClient]
  );

  const goHome = useCallback(() => {
    log.debug('Going to home');
    useNavigationStore.setState({ currentNodeId: null, mainViewType: 'node' });
  }, []);

  const processRoute = useCallback(async () => {
    if (!workspaceId || isLoadingDbs || !dbData) return;

    isProcessingUrl.current = true;
    try {
      await ensureWorkspace(workspaceId);

      if (!entityUuid) {
        goHome();
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

        if (!isDateUuid) {
          try {
            const property = await getPropertyByUuid(uuid);
            log.debug('UUID resolved to property', { uuid, id: property.id });
            openPropertyView(property.id);
            return;
          } catch {
            /* not a property */
          }
        }

        try {
          const node = await getNodeByUuid(uuid);
          log.debug('UUID resolved to node', { uuid, id: node.id, is_page: node.is_page });
          openNode(node.id);
        } catch {
          log.warn('UUID not found as property or node, going home', { uuid });
          useNavigationStore.setState({ currentNodeId: null, currentPropertyId: null });
          goHome();
        }
        return;
      }

      log.warn('Unknown route segment, going home', { segment: entityUuid });
      goHome();
    } finally {
      isProcessingUrl.current = false;
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

    const resolveSplit = async () => {
      try {
        const node = await getNodeByUuid(splitUuid);
        openNodeInNewTab(node.id);
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
