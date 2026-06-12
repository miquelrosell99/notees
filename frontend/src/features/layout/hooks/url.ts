/**
 * URL helpers for the react-router adapter layer.
 *
 * These are intentionally local to the layout adapter hooks and are NOT a
 * generic router abstraction. The rest of the app navigates via
 * navigationStore; only the route-to-URL and URL-to-route bridges need these.
 */
import type { MainViewType } from '@/stores';
import { isUuid } from '@/utils/uuid';

export const SPECIAL_VIEWS: Record<string, MainViewType | 'auth'> = {
  graph: 'graph',
  pages: 'pages',
  journal: 'journals',
  archived: 'archived',
  trash: 'trash',
  assets: 'assets',
  shares: 'shares',
  inbox: 'inbox',
  whiteboards: 'whiteboards',
  tasks: 'tasks',
  auth: 'auth',
};

export const VIEW_TO_PATH: Record<MainViewType, string> = {
  node: '',
  graph: 'graph',
  pages: 'pages',
  'all-pages': 'pages',
  journals: 'journal',
  timeline: 'timeline',
  archived: 'archived',
  trash: 'trash',
  assets: 'assets',
  shares: 'shares',
  inbox: 'inbox',
  whiteboards: 'whiteboards',
  tasks: 'tasks',
  property: '',
  'node-collection': '',
};

export function parseSplitParams(search: string): {
  splitUuid?: string;
  splitOrientation?: 'horizontal' | 'vertical';
} {
  const params = new URLSearchParams(search);
  const h = params.get('h');
  if (h && isUuid(h)) return { splitUuid: h, splitOrientation: 'horizontal' };
  const v = params.get('v');
  if (v && isUuid(v)) return { splitUuid: v, splitOrientation: 'vertical' };
  return {};
}

export function buildUrl(params: {
  viewType: MainViewType;
  nodeUuid?: string | null;
  propertyUuid?: string | null;
  workspaceUuid?: string | null;
  splitUuid?: string | null;
  splitOrientation?: 'horizontal' | 'vertical' | null;
}): string {
  const { viewType, nodeUuid, propertyUuid, workspaceUuid, splitUuid, splitOrientation } = params;

  if (!workspaceUuid) {
    return '/';
  }

  const base = `/${workspaceUuid}`;
  let path: string;

  if (viewType === 'property' && propertyUuid) {
    path = `${base}/${propertyUuid}`;
  } else if (viewType === 'node' && nodeUuid) {
    path = `${base}/${nodeUuid}`;
  } else if (VIEW_TO_PATH[viewType]) {
    path = `${base}/${VIEW_TO_PATH[viewType]}`;
  } else {
    path = base;
  }

  if (splitUuid && splitOrientation) {
    const param = splitOrientation === 'horizontal' ? 'h' : 'v';
    path += `?${param}=${splitUuid}`;
  }

  return path;
}
