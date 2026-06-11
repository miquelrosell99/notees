/**
 * useRouter hook
 */

import { useEffect, useLayoutEffect, useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigationStore, type MainViewType } from '@/stores';
import { listWorkspaces } from '@/features/workspace/api/workspaces';
import { getNodeByUuid, getNode } from '@/api/nodes';
import { getLogger } from '@/utils/logger';
import {
  parseUrl,
  pushUrl,
  type ParsedRoute,
} from './useRouter.utils';

const log = getLogger('Router');

/**
 * Hook to manage URL-based navigation
 * 
 * This hook syncs the browser URL with the app's navigation state:
 * - When app state changes, URL is updated
 * - When URL changes (browser back/forward), app state is updated
 * - On initial load, URL is parsed and appropriate navigation happens
 */
export function useRouter() {
  const hasInitialized = useRef(false);
  const isNavigatingRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  
  // Track current node UUID for URL updates
  const currentNodeUuidRef = useRef<string | null>(null);
  
  const {
    setMainViewType,
    openNode,
  } = useNavigationStore();
  
  // Fetch workspaces to validate workspace in URLs
  const { data: dbData, isLoading: isLoadingDbs } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
    staleTime: 30000,
    select: (data) => ({
      workspaces: data.items,
      active: data.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });
  
  // Subscribe to store changes to update URL
  useEffect(() => {
    if (!dbData?.active) return;
    
    // Subscribe to store changes using Zustand's subscribe
    const unsubscribe = useNavigationStore.subscribe(
      (state, prevState) => {
        // Skip if we're in the middle of navigation from URL
        if (isNavigatingRef.current) return;
        if (!dbData?.active) return;
        
        // Check if navigation state changed
        const viewChanged = state.mainViewType !== prevState.mainViewType;
        const nodeChanged = state.currentNodeId !== prevState.currentNodeId;
        
        if (!viewChanged && !nodeChanged) return;
        
        log.debug('Store state changed, updating URL', {
          viewChanged,
          nodeChanged,
          mainViewType: state.mainViewType,
          currentNodeId: state.currentNodeId,
        });
        
        // Update URL based on current state
        if (state.mainViewType === 'node' && state.currentNodeId && currentNodeUuidRef.current) {
          // Node view with UUID
          pushUrl({
            viewType: 'node',
            nodeUuid: currentNodeUuidRef.current,
          });
        } else if (state.mainViewType !== 'node' || (state.mainViewType === 'node' && !state.currentNodeId)) {
          // Special view or home
          pushUrl({
            viewType: state.mainViewType,
            nodeUuid: null,
          });
        }
      }
    );
    
    return unsubscribe;
  }, [dbData?.active]);
  
  /**
   * Navigate to home page
   */
  const navigateHome = useCallback(() => {
    log.debug('Navigating to home');
    setMainViewType('node');
    useNavigationStore.setState({ currentNodeId: null });
    const wsUuid = dbData?.active;
    const homePath = wsUuid ? `/${wsUuid}` : '/';
    window.history.replaceState(null, '', homePath);
  }, [setMainViewType, dbData?.active]);
  
  /**
   * Process a route and navigate accordingly
   */
  const processRoute = useCallback(async (route: ParsedRoute) => {
    isNavigatingRef.current = true;
    
    try {
      if (route.type === 'home') {
        // Just update state, don't change URL (it's already /)
        setMainViewType('node');
        useNavigationStore.setState({ currentNodeId: null });
        return;
      }
      
      if (route.type === 'special-view' && route.viewType) {
        log.debug('Navigating to special view', { viewType: route.viewType });
        setMainViewType(route.viewType);
        return;
      }
      
      if (route.type === 'entity' && route.entityUuid) {
        // Open the node by UUID (property resolution happens in RouterSync)
        try {
          const node = await getNodeByUuid(route.entityUuid);
          log.debug('Found node from UUID', { uuid: route.entityUuid, nodeId: node.id, is_page: node.is_page });
          currentNodeUuidRef.current = node.uuid;
          openNode(node.id);
        } catch {
          log.warn('Entity not found for UUID, navigating to home', { uuid: route.entityUuid });
          navigateHome();
        }
      }
    } finally {
      isNavigatingRef.current = false;
    }
  }, [navigateHome, openNode, setMainViewType]);
  
  /**
   * Handle initial URL on mount
   */
  useEffect(() => {
    if (hasInitialized.current || isLoadingDbs || !dbData) return;
    
    const route = parseUrl(window.location.pathname);
    log.info('Initial URL route', { pathname: window.location.pathname, route });
    
    hasInitialized.current = true;
    processRoute(route).then(() => {
      setIsReady(true);
    });
  }, [dbData, isLoadingDbs, processRoute]);
  
  /**
   * Handle browser back/forward navigation
   */
  useEffect(() => {
    const handlePopState = () => {
      if (isNavigatingRef.current || !dbData) return;
      
      const route = parseUrl(window.location.pathname);
      log.debug('Popstate navigation', { pathname: window.location.pathname, route });
      processRoute(route);
    };
    
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [dbData, processRoute]);
  
  /**
   * Update URL when navigating to a node
   * Call this after opening a node to sync the URL
   */
  const updateUrlForNode = useCallback(async (nodeId: number) => {
    try {
      // Get the node to retrieve its UUID
      const node = await getNode(nodeId);
      currentNodeUuidRef.current = node.uuid;
      
      pushUrl({
        viewType: 'node',
        nodeUuid: node.uuid,
      });
    } catch (err) {
      log.error('Failed to get node for URL update', err);
    }
  }, []);
  
  /**
   * Update URL when changing to a special view
   */
  const updateUrlForView = useCallback((viewType: MainViewType) => {
    pushUrl({
      viewType,
      nodeUuid: null,
    });
  }, []);
  
  return {
    navigateHome,
    updateUrlForNode,
    updateUrlForView,
    isReady,
    currentDbName: dbData?.active || null,
    isNavigating: isNavigatingRef.current,
  };
}

/**
 * Get the current node UUID (if known) for URL building
 */
export function useCurrentNodeUuid(): string | null {
  const { currentNodeId } = useNavigationStore();
  const [uuid, setUuid] = useState<string | null>(null);
  
  // Using useLayoutEffect to sync state before paint
  useLayoutEffect(() => {
    if (!currentNodeId) {
       
      setUuid(null);
      return;
    }
    
    // Fetch node to get UUID
    getNode(currentNodeId)
      .then(node => setUuid(node.uuid))
      .catch(() => setUuid(null));
  }, [currentNodeId]);
  
  return uuid;
}

