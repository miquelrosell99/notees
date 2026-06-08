/**
 * URL Router Hook
 * 
 * Handles URL-based navigation for the app.
 * 
 * URL patterns:
 * - /                                    -> Redirect to active workspace home
 * - /{workspace_uuid}                    -> Workspace home
 * - /{workspace_uuid}/graph              -> Graph view
 * - /{workspace_uuid}/pages              -> All pages view
 * - /{workspace_uuid}/journal            -> Journals view
 * - /{workspace_uuid}/archived           -> Archived pages view
 * - /{workspace_uuid}/trash              -> Trash view
 * - /{workspace_uuid}/assets             -> Assets view
 * - /{workspace_uuid}/{uuid}             -> Node or property view (auto-detected)
 * - /auth                                -> Auth view
 * 
 * Bookmarking any URL will restore the correct workspace + view.
 */
import { useEffect, useLayoutEffect, useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigationStore, type MainViewType } from '@/stores';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { listWorkspaces, type WorkspaceListResponse } from '@/api/workspaces';
import { getNodeByUuid, getNode } from '@/api/nodes';
import { getLogger } from '@/utils/logger';

const log = getLogger('Router');

// Special view routes
export const SPECIAL_VIEWS: Record<string, MainViewType | 'auth'> = {
  'graph': 'graph',
  'pages': 'pages',
  'journal': 'journals',
  'archived': 'archived',
  'trash': 'trash',
  'assets': 'assets',
  'shares': 'shares',
  'inbox': 'inbox',
  'whiteboards': 'whiteboards',
  'tasks': 'tasks',
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
  'pages': 'pages',
  'all-pages': 'pages',
  'journals': 'journal',
  'timeline': 'timeline',
  'archived': 'archived',
  'trash': 'trash',
  'assets': 'assets',
  'shares': 'shares',
  'inbox': 'inbox',
  'whiteboards': 'whiteboards',
  'tasks': 'tasks',
  'property': '', // Property view uses root path
  'node-collection': '', // Temporary view — no URL (falls back to home)
};

export interface ParsedRoute {
  type: 'home' | 'special-view' | 'entity' | 'auth';
  viewType?: MainViewType;
  /** UUID of a node or property — resolved at navigation time */
  entityUuid?: string;
  workspaceUuid?: string;
  /** Split pane UUID (from ?h= or ?v= query params) */
  splitUuid?: string;
  /** Split orientation derived from query param key */
  splitOrientation?: 'horizontal' | 'vertical';
}

function parseSplitParams(search: string): { splitUuid?: string; splitOrientation?: 'horizontal' | 'vertical' } {
  const params = new URLSearchParams(search);
  const h = params.get('h');
  if (h && isUuid(h)) return { splitUuid: h, splitOrientation: 'horizontal' };
  const v = params.get('v');
  if (v && isUuid(v)) return { splitUuid: v, splitOrientation: 'vertical' };
  return {};
}

/**
 * Parse URL pathname into route information
 */
export function parseUrl(pathname: string, search = ''): ParsedRoute {
  // Remove leading slash and split
  const parts = pathname.replace(/^\//, '').split('/').filter(Boolean);
  const splitInfo = parseSplitParams(search);
  
  if (parts.length === 0) {
    return { type: 'home', ...splitInfo };
  }
  
  // Auth is always at root level (no workspace prefix)
  const firstPart = parts[0].toLowerCase();
  if (firstPart === 'auth') {
    return { type: 'auth' };
  }

  // Legacy support: bare special view at root (no workspace uuid)
  // e.g. /graph -> redirect will be handled by RouterSync
  if (SPECIAL_VIEWS[firstPart] && SPECIAL_VIEWS[firstPart] !== 'auth' && !isUuid(parts[0])) {
    return { 
      type: 'special-view', 
      viewType: SPECIAL_VIEWS[firstPart] as MainViewType,
      ...splitInfo,
    };
  }
  
  // Legacy support: bare node UUID at root (no workspace prefix)
  // e.g. /{node_uuid} -> will be handled with active workspace
  if (parts.length === 1 && isUuid(parts[0]) ) {
    // Could be workspace home OR legacy node URL — we treat single UUID
    // as workspace home. Legacy node URLs without workspace prefix
    // are no longer generated.
    return {
      type: 'home',
      workspaceUuid: parts[0],
      ...splitInfo,
    };
  }
  
  // New format: /{workspace_uuid}/...
  if (isUuid(parts[0])) {
    const workspaceUuid = parts[0];
    
    // /{workspace_uuid} only -> workspace home
    if (parts.length === 1) {
      return { type: 'home', workspaceUuid, ...splitInfo };
    }
    
    const secondPart = parts[1].toLowerCase();
    
    // /{workspace_uuid}/{special_view}
    if (SPECIAL_VIEWS[secondPart] && SPECIAL_VIEWS[secondPart] !== 'auth') {
      return {
        type: 'special-view',
        viewType: SPECIAL_VIEWS[secondPart] as MainViewType,
        workspaceUuid,
        ...splitInfo,
      };
    }
    
    // /{workspace_uuid}/{entity_uuid} — could be node or property
    if (isUuid(parts[1])) {
      return {
        type: 'entity',
        entityUuid: parts[1],
        workspaceUuid,
        ...splitInfo,
      };
    }
    
    // Legacy: /{workspace_uuid}/property/{uuid} -> treat as entity
    if (secondPart === 'property' && parts.length === 3 && isUuid(parts[2])) {
      return {
        type: 'entity',
        entityUuid: parts[2],
        workspaceUuid,
        ...splitInfo,
      };
    }
  }
  
  // Legacy: /property/{uuid} (no workspace prefix)
  if (firstPart === 'property' && parts.length === 2 && isUuid(parts[1])) {
    return {
      type: 'entity',
      entityUuid: parts[1],
      ...splitInfo,
    };
  }
  
  // Unknown path - go home
  log.warn('Invalid URL path, navigating to home', { pathname });
  return { type: 'home', ...splitInfo };
}

/**
 * Build URL path from navigation state
 */
export function buildUrl(params: {
  viewType: MainViewType;
  nodeUuid?: string | null;
  propertyUuid?: string | null;
  workspaceUuid?: string | null;
  splitUuid?: string | null;
  splitOrientation?: 'horizontal' | 'vertical' | null;
}): string {
  const { viewType, nodeUuid, propertyUuid, workspaceUuid, splitUuid, splitOrientation } = params;
  
  // Without workspace UUID, fall back to root
  if (!workspaceUuid) {
    return '/';
  }
  
  const base = `/${workspaceUuid}`;
  let path: string;
  
  // Property view with UUID — same format as node: /{ws}/{uuid}
  if (viewType === 'property' && propertyUuid) {
    path = `${base}/${propertyUuid}`;
  } else if (viewType === 'node' && nodeUuid) {
    // Node view with UUID
    path = `${base}/${nodeUuid}`;
  } else if (VIEW_TO_PATH[viewType]) {
    // Special view
    path = `${base}/${VIEW_TO_PATH[viewType]}`;
  } else {
    // Workspace home
    path = `${base}`;
  }
  
  // Append split query param
  if (splitUuid && splitOrientation) {
    const param = splitOrientation === 'horizontal' ? 'h' : 'v';
    path += `?${param}=${splitUuid}`;
  }
  
  return path;
}

/**
 * Get the active workspace UUID from the workspaces query cache
 */
function getActiveWorkspaceUuid(): string | null {
  // Access the TanStack Query cache directly to get the active workspace
  // This avoids needing to pass it through every call site
  try {
    const queryClient = (window as any).__queryClient;
    if (queryClient) {
      const data = queryClient.getQueryData(['workspaces']) as WorkspaceListResponse | undefined;
      return data?.active ?? null;
    }
  } catch {
    // fallback
  }
  return null;
}

/**
 * Update browser URL to match current state (adds to history)
 */
export function pushUrl(params: {
  viewType: MainViewType;
  nodeUuid?: string | null;
  propertyUuid?: string | null;
  workspaceUuid?: string | null;
  splitUuid?: string | null;
  splitOrientation?: 'horizontal' | 'vertical' | null;
}) {
  const wsUuid = params.workspaceUuid ?? getActiveWorkspaceUuid();
  const url = buildUrl({ ...params, workspaceUuid: wsUuid });
  const currentUrl = window.location.pathname + window.location.search;
  
  if (url !== currentUrl) {
    log.debug('Pushing URL', { from: currentUrl, to: url });
    const newIndex = useNavigationHistoryStore.getState().push();
    window.history.pushState({ navIndex: newIndex }, '', url);
  }
}

/**
 * Replace browser URL (doesn't add to history)
 */
export function replaceUrl(params: {
  viewType: MainViewType;
  nodeUuid?: string | null;
  propertyUuid?: string | null;
  workspaceUuid?: string | null;
  splitUuid?: string | null;
  splitOrientation?: 'horizontal' | 'vertical' | null;
}) {
  const wsUuid = params.workspaceUuid ?? getActiveWorkspaceUuid();
  const url = buildUrl({ ...params, workspaceUuid: wsUuid });
  const currentUrl = window.location.pathname + window.location.search;
  
  if (url !== currentUrl) {
    log.debug('Replacing URL', { from: currentUrl, to: url });
    const currentIndex = useNavigationHistoryStore.getState().currentIndex;
    window.history.replaceState({ navIndex: currentIndex }, '', url);
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
  } = useNavigationStore();
  
  // Fetch workspaces to validate workspace in URLs
  const { data: dbData, isLoading: isLoadingDbs } = useQuery<WorkspaceListResponse>({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
    staleTime: 30000,
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear UUID when node is cleared
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
