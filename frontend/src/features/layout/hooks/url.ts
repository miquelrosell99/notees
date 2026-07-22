/**
 * URL helpers for the react-router adapter layer.
 *
 * These are intentionally local to the layout adapter hooks and are NOT a
 * generic router abstraction. The rest of the app navigates via
 * navigationStore; only the route-to-URL and URL-to-route bridges need these.
 */
import type { MainViewType } from '@/stores';

export const SPECIAL_VIEWS: Record<string, MainViewType | 'auth'> = {
  graph: 'graph',
  pages: 'pages',
  classes: 'classes',
  journal: 'journals',
  archived: 'archived',
  trash: 'trash',
  assets: 'assets',
  shares: 'shares',
  inbox: 'inbox',
  whiteboards: 'whiteboards',
  templates: 'templates',
  flashcards: 'flashcards',
  auth: 'auth',
};

export const VIEW_TO_PATH: Record<MainViewType, string> = {
  node: '',
  graph: 'graph',
  pages: 'pages',
  'all-pages': 'pages',
  classes: 'classes',
  journals: 'journal',
  timeline: 'timeline',
  archived: 'archived',
  trash: 'trash',
  assets: 'assets',
  shares: 'shares',
  inbox: 'inbox',
  whiteboards: 'whiteboards',
  templates: 'templates',
  flashcards: 'flashcards',
  property: '',
  'node-collection': '',
};

export function buildUrl(params: {
  viewType: MainViewType;
  nodeUuid?: string | null;
  propertyUuid?: string | null;
  workspaceUuid?: string | null;
}): string {
  const { viewType, nodeUuid, propertyUuid, workspaceUuid } = params;

  if (!workspaceUuid) {
    return '/';
  }

  const base = `/${workspaceUuid}`;

  if (viewType === 'property' && propertyUuid) {
    return `${base}/${propertyUuid}`;
  } else if (viewType === 'node' && nodeUuid) {
    return `${base}/${nodeUuid}`;
  } else if (VIEW_TO_PATH[viewType]) {
    return `${base}/${VIEW_TO_PATH[viewType]}`;
  } else {
    return base;
  }
}
