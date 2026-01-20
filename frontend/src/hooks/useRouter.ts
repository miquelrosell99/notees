/**
 * URL Router Hook
 * 
 * Handles URL-based navigation for the app.
 * 
 * URL patterns:
 * - /                     -> Home (default view based on settings)
 * - /graph                -> Graph view
 * - /pages                -> All pages view
 * - /journal              -> Journals view
 * - /archived             -> Archived pages view
 * - /assets               -> Assets view
 * - /{uuid}               -> Node view (UUID format: 8-4-4-4-12 hex chars)
 * 
 * The database is determined by the active database in the user's session.
 */
import { useEffect, useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNodesStore, type MainViewType } from '@/stores';
import { listDatabases, type DatabaseListResponse } from '@/api/databases';
import { getNodeByUuid, getNode } from '@/api/nodes';
import { getLogger } from '@/utils/logger';

const log = getLogger('Router');

// Special view routes
export const SPECIAL_VIEWS: Record<string, MainViewType | 'auth'> = {
  'graph': 'graph',
  'pages': 'all-pages',
  'journal': 'journals',
  'archived': 'archived',
  'assets': 'assets',
  'auth': 'auth',
};

// UUID regex pattern (8-4-4-4-12 hex characters)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID
 */
export function isUuid(str: string): boolean {
  return UUID_REGEX.test(str);
}

// Reverse mapping for URL generation
export const VIEW_TO_PATH: Record<MainViewType, string> = {
  'node': '', // Node view uses /{uuid} format (empty string for home)
  'graph': 'graph',
  'all-pages': 'pages',
  'journals': 'journal',
  'archived': 'archived',
  'assets': 'assets',
  'property': '', // Property view uses root path
};

export interface ParsedRoute {
  type: 'home' | 'special-view' | 'node' | 'auth';
  viewType?: MainViewType;
  nodeUuid?: string;
}

/**
 * Parse URL pathname into route information
 */
export function parseUrl(pathname: string): ParsedRoute {
  // Remove leading slash and split
  const parts = pathname.replace(/^\//, '').split('/').filter(Boolean);
  
  if (parts.length === 0) {
    return { type: 'home' };
  }
  
  // Check if first part is a special view or auth
  const firstPart = parts[0].toLowerCase();
  if (firstPart === 'auth') {
    return { type: 'auth' };
  }
  if (SPECIAL_VIEWS[firstPart] && SPECIAL_VIEWS[firstPart] !== 'auth') {
    return { 
      type: 'special-view', 
      viewType: SPECIAL_VIEWS[firstPart] as MainViewType
    };
  }
  
  // Check if it's a UUID (node route)
  if (isUuid(parts[0])) {
    return {
      type: 'node',
      nodeUuid: parts[0],
    };
  }
  
  // Unknown path - go home
  log.warn('Invalid URL path, navigating to home', { pathname });
  return { type: 'home' };
}

/**
 * Build URL path from navigation state
 */
export function buildUrl(params: {
  viewType: MainViewType;
  nodeUuid?: string | null;
}): string {
  const { viewType, nodeUuid } = params;
  
  // Get the view path
  const viewPath = VIEW_TO_PATH[viewType];
  
  // Node view with UUID
  if (viewType === 'node' && nodeUuid) {
    return `/${nodeUuid}`;
  }
  
  // Special view
  if (viewPath) {
    return `/${viewPath}`;
  }
  
  // Home (node view without UUID, or property view)
  return '/';
}

/**
 * Update browser URL to match current state (adds to history)
 */
export function pushUrl(params: {
  viewType: MainViewType;
  nodeUuid?: string | null;
}) {
  const url = buildUrl(params);
  const currentPath = window.location.pathname;
  
  if (url !== currentPath) {
    log.debug('Pushing URL', { from: currentPath, to: url });
    window.history.pushState(null, '', url);
  }
}

/**
 * Replace browser URL (doesn't add to history)
 */
export function replaceUrl(params: {
  viewType: MainViewType;
  nodeUuid?: string | null;
}) {
  const url = buildUrl(params);
  const currentPath = window.location.pathname;
  
  if (url !== currentPath) {
    log.debug('Replacing URL', { from: currentPath, to: url });
    window.history.replaceState(null, '', url);
  }
}

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
  } = useNodesStore();
  
  // Fetch databases to validate db name in URLs
  const { data: dbData, isLoading: isLoadingDbs } = useQuery<DatabaseListResponse>({
    queryKey: ['databases'],
    queryFn: listDatabases,
    staleTime: 30000,
  });
  
  // Subscribe to store changes to update URL
  useEffect(() => {
    if (!dbData?.active) return;
    
    // Subscribe to store changes using Zustand's subscribe
    const unsubscribe = useNodesStore.subscribe(
      (state, prevState) => {
        // Skip if we're in the middle of navigation from URL
        if (isNavigatingRef.current) return;
        if (!dbData?.active) return;
        
        // Check if navigation state changed
        const viewChanged = state.mainViewType !== prevState.mainViewType;
        const nodeChanged = state.currentNodeId !== prevState.currentNodeId;
        const typeChanged = state.currentNodeType !== prevState.currentNodeType;
        
        if (!viewChanged && !nodeChanged && !typeChanged) return;
        
        log.debug('Store state changed, updating URL', {
          viewChanged,
          nodeChanged,
          typeChanged,
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
    useNodesStore.setState({ currentNodeId: null });
    window.history.replaceState(null, '', '/');
  }, [setMainViewType]);
  
  /**
   * Process a route and navigate accordingly
   */
  const processRoute = useCallback(async (route: ParsedRoute) => {
    isNavigatingRef.current = true;
    
    try {
      if (route.type === 'home') {
        // Just update state, don't change URL (it's already /)
        setMainViewType('node');
        useNodesStore.setState({ currentNodeId: null });
        return;
      }
      
      if (route.type === 'special-view' && route.viewType) {
        log.debug('Navigating to special view', { viewType: route.viewType });
        setMainViewType(route.viewType);
        return;
      }
      
      if (route.type === 'node' && route.nodeUuid) {
        // Open the node by UUID
        try {
          const node = await getNodeByUuid(route.nodeUuid);
          log.debug('Found node from UUID', { uuid: route.nodeUuid, nodeId: node.id, is_page: node.is_page });
          currentNodeUuidRef.current = node.uuid;
          openNode(node.id, node.is_page ? 'page' : 'block');
        } catch (err) {
          log.warn('Node not found for UUID, navigating to home', { uuid: route.nodeUuid });
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
  const { currentNodeId } = useNodesStore();
  const [uuid, setUuid] = useState<string | null>(null);
  
  useEffect(() => {
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
