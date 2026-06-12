import { useEffect, useCallback, type MutableRefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigationStore } from '@/stores';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { listWorkspaces, switchWorkspace } from '@/features/workspace/api/workspaces';
import { getNodeByUuid } from '@/api/nodes';
import { getPropertyByUuid } from '@/api/properties';
import { parseUrl, replaceUrl, type ParsedRoute } from '@/hooks/useRouter';
import { favoriteKeys, recentKeys } from '@/hooks/queryKeys';
import { getLogger } from '@/utils/logger';
import { isDayUuid, isMonthUuid, isYearUuid } from '@/utils/dateUuid';

const log = getLogger('RouterSync');

export function useRouterSync(
  hasInitialized: MutableRefObject<boolean>,
  isProcessingUrl: MutableRefObject<boolean>,
) {
  const {
    setMainViewType,
    openNode,
    openPropertyView,
    openNodeInNewTab,
  } = useNavigationStore();

  const queryClient = useQueryClient();

  const { data: dbData, isLoading: isLoadingDbs } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
    staleTime: 30000,
    select: (data) => ({
      workspaces: data.items,
      active: data.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });

  const ensureWorkspace = useCallback(async (targetWsUuid: string): Promise<boolean> => {
    if (!dbData) return false;
    if (dbData.active === targetWsUuid) return false;

    const ws = dbData.workspaces.find(w => w.uuid === targetWsUuid);
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
  }, [dbData, queryClient]);

  const goHome = useCallback(() => {
    log.debug('Going to home');
    useNavigationStore.setState({
      currentNodeId: null,
      mainViewType: 'node',
    });
    replaceUrl({ viewType: 'node', nodeUuid: null });
  }, []);

  const processRoute = useCallback(async (route: ParsedRoute) => {
    isProcessingUrl.current = true;
    try {
      if (route.workspaceUuid) {
        const switched = await ensureWorkspace(route.workspaceUuid);
        if (switched) log.debug('Workspace switch completed, continuing route processing');
      }

      if (route.type === 'home') {
        log.debug('Route: home');
        useNavigationStore.setState({ currentNodeId: null, mainViewType: 'node' });
        return;
      }

      if (route.type === 'special-view' && route.viewType) {
        log.debug('Route: special view', { viewType: route.viewType });
        setMainViewType(route.viewType);
        return;
      }

      if (route.type === 'entity' && route.entityUuid) {
        const uuid = route.entityUuid;
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
      }
    } finally {
      isProcessingUrl.current = false;
    }
  }, [goHome, openNode, openPropertyView, setMainViewType, ensureWorkspace]);

  // Initial mount: handle special views immediately
  useEffect(() => {
    if (hasInitialized.current) return;

    if (!window.history.state?.navIndex) {
      window.history.replaceState({ navIndex: 0 }, '', window.location.pathname);
    }

    const currentPath = window.location.pathname;
    const route = parseUrl(currentPath, window.location.search);

    if (route.type === 'special-view' && route.viewType && route.workspaceUuid) {
      log.info('Processing special view URL immediately', { path: currentPath, viewType: route.viewType });
      hasInitialized.current = true;
      setMainViewType(route.viewType);
      return;
    }

    if (route.type === 'home' && !route.workspaceUuid) return;
  }, [setMainViewType]);

  // DB-dependent route processing
  useEffect(() => {
    if (hasInitialized.current || isLoadingDbs || !dbData) return;

    const currentPath = window.location.pathname;
    const route = parseUrl(currentPath, window.location.search);

    log.info('Processing URL', { path: currentPath, route });
    hasInitialized.current = true;

    if (route.type === 'home' && !route.workspaceUuid) {
      if (dbData.active) {
        useNavigationStore.setState({ currentNodeId: null, mainViewType: 'node' });
        window.history.replaceState({ navIndex: 0 }, '', `/${dbData.active}`);
      } else {
        useNavigationStore.setState({ currentNodeId: null, mainViewType: 'node' });
      }
      return;
    }

    if (route.type === 'special-view' && !route.workspaceUuid && dbData.active) {
      setMainViewType(route.viewType!);
      const viewPath = route.viewType === 'all-pages' ? 'pages' :
        route.viewType === 'journals' ? 'journal' : route.viewType;
      window.history.replaceState({ navIndex: 0 }, '', `/${dbData.active}/${viewPath}`);
      return;
    }

    processRoute(route).then(() => {
      if (route.splitUuid && route.splitOrientation) {
        const resolveSplit = async () => {
          try {
            const node = await getNodeByUuid(route.splitUuid!);
            openNodeInNewTab(node.id);
            const state = useNavigationStore.getState();
            const newTab = state.tabs[state.tabs.length - 1];
            if (newTab) {
              useNavigationStore.setState({
                activeTabId: state.tabs[0]?.id ?? newTab.id,
                secondaryTabId: newTab.id,
                splitOrientation: route.splitOrientation!,
              });
            }
          } catch {
            log.warn('Split UUID not found, ignoring split', { uuid: route.splitUuid });
          }
        };
        resolveSplit();
      }
    });
  }, [dbData, isLoadingDbs, processRoute, setMainViewType, openNodeInNewTab]);

  // Popstate handler
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const navIndex = event.state?.navIndex ?? 0;
      useNavigationHistoryStore.getState().handlePopState(navIndex);
      const route = parseUrl(window.location.pathname, window.location.search);
      log.debug('Popstate event', { path: window.location.pathname, search: window.location.search, route, navIndex });
      processRoute(route);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [processRoute]);

  return { dbData, processRoute };
}
