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
 */
import { useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppStore, type MainViewType } from '@/stores';
import { listWorkspaces, type WorkspaceListResponse } from '@/api/workspaces';
import { getNodeByUuid, getNode } from '@/api/nodes';
import { getPropertyByUuid } from '@/api/properties';
import { parseUrl, pushUrl, replaceUrl, type ParsedRoute } from './useRouter';
import { getLogger } from '@/utils/logger';

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
  } | null>(null);
  
  const { 
    mainViewType, 
    currentNodeId,
    currentPropertyId,
    setMainViewType,
    openNode,
    openPropertyView,
  } = useAppStore();
  
  // Fetch workspaces
  const { data: dbData, isLoading: isLoadingDbs } = useQuery<WorkspaceListResponse>({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
    staleTime: 30000,
  });
  
  /**
   * Navigate to home (clears node, shows welcome)
   */
  const goHome = useCallback(() => {
    log.debug('Going to home');
    useAppStore.setState({ 
      currentNodeId: null,
      mainViewType: 'node',
    });
    replaceUrl({ viewType: 'node', nodeUuid: null });
  }, []);
  
  /**
   * Process a parsed route and update app state
   */
  const processRoute = useCallback(async (route: ParsedRoute) => {
    isProcessingUrl.current = true;
    
    try {
      if (route.type === 'home') {
        log.debug('Route: home');
        useAppStore.setState({ 
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
      
      if (route.type === 'property' && route.propertyUuid) {
        // Open property view by UUID
        try {
          const property = await getPropertyByUuid(route.propertyUuid);
          log.debug('Found property from URL', { uuid: route.propertyUuid, id: property.id });
          openPropertyView(property.id);
        } catch (err) {
          log.warn('Property not found for UUID in URL, going home', { uuid: route.propertyUuid });
          useAppStore.setState({ currentPropertyId: null });
          goHome();
        }
        return;
      }
      
      if (route.type === 'node' && route.nodeUuid) {
        // Open the node by UUID
        try {
          const node = await getNodeByUuid(route.nodeUuid);
          log.debug('Found node from URL', { uuid: route.nodeUuid, id: node.id, is_page: node.is_page });
          openNode(node.id);
        } catch (err) {
          log.warn('Node not found for UUID in URL, going home', { uuid: route.nodeUuid });
          // Clear any potentially set node ID before going home
          useAppStore.setState({ currentNodeId: null });
          goHome();
        }
      }
    } finally {
      isProcessingUrl.current = false;
    }
  }, [goHome, openNode, openPropertyView, setMainViewType]);
  
  /**
   * Handle special view routes immediately on mount
   */
  useEffect(() => {
    if (hasInitialized.current) return;
    
    const currentPath = window.location.pathname;
    const route = parseUrl(currentPath);
    
    // Handle special views immediately - they don't need database data
    if (route.type === 'special-view' && route.viewType) {
      log.info('Processing special view URL immediately', { path: currentPath, viewType: route.viewType });
      hasInitialized.current = true;
      setMainViewType(route.viewType);
      return;
    }
    
    // Home route also doesn't need db data
    if (route.type === 'home') {
      log.info('Processing home URL immediately', { path: currentPath });
      hasInitialized.current = true;
      useAppStore.setState({ 
        currentNodeId: null,
        mainViewType: 'node',
      });
      return;
    }
    
    // Node routes will be handled by the db-dependent effect below
  }, [setMainViewType]);
  
  /**
   * Handle routes that require database data (node and property routes)
   */
  useEffect(() => {
    if (hasInitialized.current || isLoadingDbs || !dbData) return;
    
    const currentPath = window.location.pathname;
    const route = parseUrl(currentPath);
    
    // Only handle node and property routes here (they need the database to be ready)
    if (route.type !== 'node' && route.type !== 'property') return;
    
    log.info('Processing URL', { path: currentPath, route });
    hasInitialized.current = true;
    
    // Process the route
    processRoute(route);
  }, [dbData, isLoadingDbs, processRoute]);
  
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
      prevState.currentPropertyId !== currentPropertyId;
    
    if (!stateChanged) return;
    
    // Update ref
    prevStateRef.current = { mainViewType, currentNodeId, currentPropertyId };
    
    // Build and push URL
    const updateUrlAsync = async () => {
      // Property view
      if (mainViewType === 'property' && currentPropertyId) {
        try {
          const { getProperty } = await import('@/api/properties');
          const property = await getProperty(currentPropertyId);
          pushUrl({
            viewType: 'property',
            nodeUuid: null,
            propertyUuid: property.uuid,
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
        });
      }
    };
    
    updateUrlAsync();
  }, [mainViewType, currentNodeId, currentPropertyId]);
  
  /**
   * Handle browser back/forward navigation
   */
  useEffect(() => {
    const handlePopState = () => {
      const route = parseUrl(window.location.pathname);
      log.debug('Popstate event', { path: window.location.pathname, route });
      processRoute(route);
    };
    
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [processRoute]);
  
  return <>{children}</>;
}
