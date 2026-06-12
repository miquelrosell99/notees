/**
 * Router utilities — constants, URL parsing, and navigation helpers
 */

import type { MainViewType } from '@/stores';
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

