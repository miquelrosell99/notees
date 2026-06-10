/**
 * RouterSync Component
 * 
 * This component handles synchronization between the app's navigation state
 * and the browser URL. It should be rendered inside the Layout component.
 * 
 * Responsibilities:
 * - Handle initial URL navigation on page load
 * - Update URL when navigation state changes (via store)
 * - Handle browser back/forward navigation (popstate)
 * - Auto-switch workspace when URL targets a different workspace
 */
import { useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigationStore, type MainViewType } from '@/stores';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { useFavoritesStore } from '@/stores/favoritesStore';
import { listWorkspaces, switchWorkspace } from '@/api/workspaces';
import { getNodeByUuid, getNode } from '@/api/nodes';
import { getPropertyByUuid } from '@/api/properties';
import { parseUrl, pushUrl, replaceUrl, type ParsedRoute } from './useRouter';
import { getLogger } from '@/utils/logger';
import { isDayUuid, isMonthUuid, isYearUuid } from '@/utils/dateUuid';

const log = getLogger('RouterSync');

interface RouterSyncProps {
  children: React.ReactNode;
}

export function RouterSync({ children }: RouterSyncProps) {
  const hasInitialized = useRef(false);
  const isProcessingUrl = useRef(false);
  
  // Track the last known state to detect changes
  const prevStateRef = useRef<{
    mainViewType: MainViewType;
    currentNodeId: number | null;
    currentPropertyId: number | null;
    secondaryTabId: string | null;
    splitOrientation: string | null;
  } | null>(null);
  
  const { 
    mainViewType, 
    currentNodeId,
    currentPropertyId,
    tabs,
    secondaryTabId,
    splitOrientation,
    setMainViewType,
    openNode,
    openPropertyView,
    openNodeInNewTab,
  } = useNavigationStore();
  
  const queryClient = useQueryClient();
  
  // Fetch workspaces
  const { data: dbData, isLoading: isLoadingDbs } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
    staleTime: 30000,
    select: (data) => ({
      workspaces: data.items,
      active: data.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });
  
  /**
   * Switch to a different workspace, clear caches, update query data.
   * Returns true if switch was performed, false if already on that workspace.
   */
  const ensureWorkspace = useCallback(async (targetWsUuid: string): Promise<boolean> => {
    if (!dbData) return false;
    
    // Already on the right workspace
    if (dbData.active === targetWsUuid) return false;
    
    // Check the user actually has access to this workspace
    const ws = dbData.workspaces.find(w => w.uuid === targetWsUuid);
    if (!ws) {
      log.warn('Workspace not found or no access', { targetWsUuid });
      return false;
    }
    
    log.info('Auto-switching workspace for URL', { from: dbData.active, to: targetWsUuid });
    
    // Perform the switch
    await switchWorkspace(targetWsUuid);
    
    // Reset navigation state
    useNavigationStore.setState({
      currentNodeId: null,
      activeNode: null,
      activeNodeId: null,
      sidebarNode: null,
      localGraphNodeId: null,
      mainViewType: 'node',
    });
    
    // Clear favorites
    useFavoritesStore.getState().clear();
    
    // Clear ALL cached data to prevent stale data from previous workspace
    queryClient.clear();
    
    // Refetch workspaces so dbData.active is updated
    await queryClient.fetchQuery({
      queryKey: ['workspaces'],
      queryFn: () => listWorkspaces(),
    });
    
    useFavoritesStore.getState().refresh();
    
    return true;
  }, [dbData, queryClient]);
  
  /**
   * Navigate to home (clears node, shows welcome)
   */
  const goHome = useCallback(() => {
    log.debug('Going to home');
    useNavigationStore.setState({ 
      currentNodeId: null,
      mainViewType: 'node',
    });
    replaceUrl({ viewType: 'node', nodeUuid: null });
  }, []);
  
  /**
   * Process a parsed route and update app state.
   * If the route targets a different workspace, switch first.
   */
  const processRoute = useCallback(async (route: ParsedRoute) => {
    isProcessingUrl.current = true;
    
    try {
      // Handle workspace switch if needed
      if (route.workspaceUuid) {
        const switched = await ensureWorkspace(route.workspaceUuid);
        if (switched) {
          log.debug('Workspace switch completed, continuing route processing');
        }
      }
      
      if (route.type === 'home') {
        log.debug('Route: home');
        useNavigationStore.setState({ 
          currentNodeId: null,
          mainViewType: 'node',
        });
        return;
      }
      
      if (route.type === 'special-view' && route.viewType) {
        log.debug('Route: special view', { viewType: route.viewType });
        setMainViewType(route.viewType);
        return;
      }
      
      if (route.type === 'entity' && route.entityUuid) {
        const uuid = route.entityUuid;

        // Date-based UUIDs (daily/monthly/yearly journals) are always nodes,
        // never properties. Skip the property lookup to avoid 404 noise.
        const isDateUuid = isDayUuid(uuid) || isMonthUuid(uuid) || isYearUuid(uuid);

        if (!isDateUuid) {
          // Try property first (lower volume, faster to rule out)
          try {
            const property = await getPropertyByUuid(uuid);
            log.debug('UUID resolved to property', { uuid, id: property.id });
            openPropertyView(property.id);
            return;
          } catch {
            // Not a property — fall through to node lookup
          }
        }

        // Try node
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
  
  /**
   * Handle special view routes immediately on mount
   */
  useEffect(() => {
    if (hasInitialized.current) return;
    
    // Set initial history state so popstate events include navIndex
    if (!window.history.state?.navIndex) {
      window.history.replaceState({ navIndex: 0 }, '', window.location.pathname);
    }
    
    const currentPath = window.location.pathname;
    const route = parseUrl(currentPath, window.location.search);
    
    // Handle special views immediately (with workspace UUID) - they don't need database data
    if (route.type === 'special-view' && route.viewType && route.workspaceUuid) {
      log.info('Processing special view URL immediately', { path: currentPath, viewType: route.viewType });
      hasInitialized.current = true;
      setMainViewType(route.viewType);
      return;
    }
    
    // Home route also doesn't need db data (bare / with no workspace)
    if (route.type === 'home' && !route.workspaceUuid) {
      // Don't mark initialized yet — wait for db data so we can redirect to /{workspace_uuid}
      return;
    }
    
    // Handle split params on initial load
    if (route.splitUuid && route.splitOrientation) {
      // We'll resolve the split after the primary route is processed
      // Store it in a ref for the next effect
    }
    
    // Node/property/workspace-home routes will be handled by the db-dependent effect below
  }, [setMainViewType]);
  
  /**
   * Handle routes that require database data
   */
  useEffect(() => {
    if (hasInitialized.current || isLoadingDbs || !dbData) return;
    
    const currentPath = window.location.pathname;
    const route = parseUrl(currentPath, window.location.search);
    
    log.info('Processing URL', { path: currentPath, route });
    hasInitialized.current = true;
    
    // Bare / with no workspace -> redirect to active workspace home
    if (route.type === 'home' && !route.workspaceUuid) {
      if (dbData.active) {
        useNavigationStore.setState({ currentNodeId: null, mainViewType: 'node' });
        window.history.replaceState({ navIndex: 0 }, '', `/${dbData.active}`);
      } else {
        useNavigationStore.setState({ currentNodeId: null, mainViewType: 'node' });
      }
      return;
    }
    
    // Legacy: special view without workspace prefix (e.g. /graph) -> redirect
    if (route.type === 'special-view' && !route.workspaceUuid && dbData.active) {
      setMainViewType(route.viewType!);
      const viewPath = route.viewType === 'all-pages' ? 'pages' : 
                       route.viewType === 'journals' ? 'journal' : route.viewType;
      window.history.replaceState({ navIndex: 0 }, '', `/${dbData.active}/${viewPath}`);
      return;
    }
    
    // Process the route (handles workspace switching, node loading, etc.)
    processRoute(route).then(() => {
      // After primary route is processed, handle split if present
      if (route.splitUuid && route.splitOrientation) {
        const resolveSplit = async () => {
          try {
            const node = await getNodeByUuid(route.splitUuid!);
            // Open the split node in a new tab, then activate the original tab
            openNodeInNewTab(node.id);
            // Activate the first tab (primary) and set this new tab as secondary
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
  
  /**
   * Update URL when navigation state changes
   * This runs after any navigation action in the store
   */
  useEffect(() => {
    // Skip if we're processing a URL-initiated navigation
    if (isProcessingUrl.current) return;
    
    // Skip if not initialized
    if (!hasInitialized.current) return;
    
    // Detect if state actually changed
    const prevState = prevStateRef.current;
    const stateChanged = !prevState || 
      prevState.mainViewType !== mainViewType ||
      prevState.currentNodeId !== currentNodeId ||
      prevState.currentPropertyId !== currentPropertyId ||
      prevState.secondaryTabId !== secondaryTabId ||
      prevState.splitOrientation !== (splitOrientation ?? null);
    
    if (!stateChanged) return;
    
    // Update ref
    prevStateRef.current = { mainViewType, currentNodeId, currentPropertyId, secondaryTabId: secondaryTabId ?? null, splitOrientation: splitOrientation ?? null };
    
    // Build and push URL
    const updateUrlAsync = async () => {
      // Resolve secondary tab UUID for split URLs
      let splitUuid: string | undefined;
      const splitOrient = splitOrientation;
      const secondaryTab = tabs.find((t) => t.id === secondaryTabId);
      if (secondaryTab && splitOrient) {
        if (secondaryTab.nodeId) {
          try {
            const node = await getNode(secondaryTab.nodeId);
            splitUuid = node.uuid;
          } catch {
            // ignore
          }
        } else if (secondaryTab.propertyId) {
          try {
            const { getProperty } = await import('@/api/properties');
            const property = await getProperty(secondaryTab.propertyId);
            splitUuid = property.uuid;
          } catch {
            // ignore
          }
        }
      }
      
      // Property view
      if (mainViewType === 'property' && currentPropertyId) {
        try {
          const { getProperty } = await import('@/api/properties');
          const property = await getProperty(currentPropertyId);
          pushUrl({
            viewType: 'property',
            nodeUuid: null,
            propertyUuid: property.uuid,
            splitUuid,
            splitOrientation: splitOrient,
          });
        } catch (err) {
          log.error('Failed to get property UUID for URL', err);
        }
        return;
      }
      
      // Special views (non-node, non-property)
      if (mainViewType !== 'node' && mainViewType !== 'property') {
        pushUrl({ 
          viewType: mainViewType, 
          nodeUuid: null,
          propertyUuid: null,
          splitUuid,
          splitOrientation: splitOrient,
        });
        return;
      }
      
      // Node view
      if (mainViewType === 'node' && currentNodeId) {
        try {
          const node = await getNode(currentNodeId);
          pushUrl({
            viewType: 'node',
            nodeUuid: node.uuid,
            propertyUuid: null,
            splitUuid,
            splitOrientation: splitOrient,
          });
        } catch (err) {
          log.error('Failed to get node UUID for URL', err);
        }
      } else {
        // No node selected, go to home
        pushUrl({ 
          viewType: 'node', 
          nodeUuid: null,
          propertyUuid: null,
          splitUuid,
          splitOrientation: splitOrient,
        });
      }
    };
    
    updateUrlAsync();
  }, [mainViewType, currentNodeId, currentPropertyId]);
  
  /**
   * Handle browser back/forward navigation
   */
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
  
  return <>{children}</>;
}
