/**
 * searchIndex — client-side full-text index for offline search.
 *
 * Uses MiniSearch to index node name text and stores filterable metadata
 * (class/tag/parent/page) so offline search can match the server API filters.
 *
 * The index is persisted to IndexedDB and reloaded on startup.
 */

import MiniSearch from 'minisearch';
import { get, set, del } from 'idb-keyval';
import type { Node } from '@/types/api';
import { nodeNameToText } from '@/features/queries';

const STORAGE_KEY_PREFIX = 'notees:search-index';

export interface SearchFilters {
  isPage?: boolean;
  isClass?: boolean;
  isDaily?: boolean;
  isUserPage?: boolean;
  classUuids?: string[];
  tagUuids?: string[];
}

export interface SearchDoc {
  id: string;
  nameText: string;
  isPage: boolean;
  isClass: boolean;
  isDaily: boolean;
  isUserPage: boolean;
  classUuids: string[];
  tagUuids: string[];
  parentUuid: string | null;
  pageUuid: string | null;
}

export interface SearchResult {
  id: string;
  score: number;
  match: Record<string, unknown>;
}

const memoryStore = new Map<string, MiniSearch<SearchDoc>>();
const hasIndexedDB = typeof indexedDB !== 'undefined';

function workspaceKey(workspaceUuid: string): string {
  return `${STORAGE_KEY_PREFIX}:${workspaceUuid}`;
}

function nodeToDoc(node: Node): SearchDoc {
  return {
    id: node.uuid,
    nameText: nodeNameToText(node.name),
    isPage: node.is_page ?? false,
    isClass: node.is_class ?? false,
    isDaily: node.is_daily ?? false,
    isUserPage: false, // not exposed as a top-level flag on Node; derived from context if needed
    classUuids: node.classes_uuid ?? [],
    tagUuids: node.tags_uuid ?? [],
    parentUuid: node.parent_uuid,
    pageUuid: node.page_uuid,
  };
}

function createMiniSearch(): MiniSearch<SearchDoc> {
  return new MiniSearch<SearchDoc>({
    fields: ['nameText'],
    storeFields: [
      'id',
      'nameText',
      'isPage',
      'isClass',
      'isDaily',
      'isUserPage',
      'classUuids',
      'tagUuids',
      'parentUuid',
      'pageUuid',
    ],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
    },
  });
}

async function idbGet(workspaceUuid: string): Promise<MiniSearch<SearchDoc> | undefined> {
  const key = workspaceKey(workspaceUuid);
  if (hasIndexedDB) {
    const json = await get<string>(key);
    if (!json) return undefined;
    return MiniSearch.loadJSON(json, {
      fields: ['nameText'],
      storeFields: [
        'id',
        'nameText',
        'isPage',
        'isClass',
        'isDaily',
        'isUserPage',
        'classUuids',
        'tagUuids',
        'parentUuid',
        'pageUuid',
      ],
    });
  }
  return memoryStore.get(key);
}

async function idbSet(workspaceUuid: string, index: MiniSearch<SearchDoc>): Promise<void> {
  const key = workspaceKey(workspaceUuid);
  if (hasIndexedDB) {
    await set(key, JSON.stringify(index.toJSON()));
  } else {
    memoryStore.set(key, index);
  }
}

async function idbDelete(workspaceUuid: string): Promise<void> {
  const key = workspaceKey(workspaceUuid);
  if (hasIndexedDB) {
    await del(key);
  } else {
    memoryStore.delete(key);
  }
}

async function getIndex(workspaceUuid: string): Promise<MiniSearch<SearchDoc>> {
  let index = await idbGet(workspaceUuid);
  if (!index) {
    index = createMiniSearch();
    await idbSet(workspaceUuid, index);
  }
  return index;
}

/**
 * Add or update nodes in the search index.
 */
export async function indexNodes(
  workspaceUuid: string,
  nodes: Node[],
): Promise<void> {
  if (nodes.length === 0) return;
  const index = await getIndex(workspaceUuid);
  for (const node of nodes) {
    if (index.has(node.uuid)) {
      index.discard(node.uuid);
    }
  }
  index.addAll(nodes.map(nodeToDoc));
  await idbSet(workspaceUuid, index);
}

/**
 * Remove nodes from the search index.
 */
export async function unindexNodes(
  workspaceUuid: string,
  nodeUuids: string[],
): Promise<void> {
  if (nodeUuids.length === 0) return;
  const index = await getIndex(workspaceUuid);
  for (const uuid of nodeUuids) {
    if (index.has(uuid)) {
      index.discard(uuid);
    }
  }
  await idbSet(workspaceUuid, index);
}

function hasIntersection(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  return b.some((x) => setA.has(x));
}

function matchesFilters(doc: SearchDoc, filters: SearchFilters): boolean {
  if (filters.isPage !== undefined && doc.isPage !== filters.isPage) return false;
  if (filters.isClass !== undefined && doc.isClass !== filters.isClass) return false;
  if (filters.isDaily !== undefined && doc.isDaily !== filters.isDaily) return false;
  if (filters.isUserPage !== undefined && doc.isUserPage !== filters.isUserPage) return false;
  if (filters.classUuids && filters.classUuids.length > 0) {
    if (!hasIntersection(doc.classUuids, filters.classUuids)) return false;
  }
  if (filters.tagUuids && filters.tagUuids.length > 0) {
    if (!hasIntersection(doc.tagUuids, filters.tagUuids)) return false;
  }
  return true;
}

/**
 * Search the local index.
 */
export async function searchIndex(
  workspaceUuid: string,
  query: string,
  filters: SearchFilters = {},
): Promise<SearchResult[]> {
  const index = await getIndex(workspaceUuid);
  if (!query.trim()) {
    // Empty query: return all indexed docs, filtered.
    const all = index.search('*');
    return all.filter((r) => matchesFilters(r as unknown as SearchDoc, filters));
  }
  const raw = index.search(query);
  return raw.filter((r) => matchesFilters(r as unknown as SearchDoc, filters));
}

/**
 * Wipe the search index for a workspace.
 */
export async function clearSearchIndex(workspaceUuid: string): Promise<void> {
  await idbDelete(workspaceUuid);
}

/**
 * Reset the in-memory fallback. Intended for tests only.
 */
export function _resetMemoryIndex(): void {
  memoryStore.clear();
}
