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
const indexLocks = new Map<string, Promise<void>>();
const hasIndexedDB = typeof indexedDB !== 'undefined';

/**
 * Serialize all index operations for a workspace. MiniSearch (and its
 * internal SearchableMap) is not safe against concurrent async mutations:
 * overlapping discard/add cycles can corrupt the radix tree and cause
 * vacuuming to throw "child is undefined".
 */
async function withIndexLock<T>(workspaceUuid: string, fn: () => Promise<T>): Promise<T> {
  while (indexLocks.has(workspaceUuid)) {
    await indexLocks.get(workspaceUuid);
  }
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  indexLocks.set(workspaceUuid, promise);
  try {
    return await fn();
  } finally {
    indexLocks.delete(workspaceUuid);
    release!();
  }
}

const PERSIST_DEBOUNCE_MS = 2000;
const PERSIST_IDLE_TIMEOUT_MS = 2000;

let pendingSaveWorkspaceUuid: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveIdleHandle: number | null = null;

const scheduleIdle: (cb: () => void, opts?: { timeout?: number }) => number =
  typeof requestIdleCallback !== 'undefined'
    ? (cb, opts) => requestIdleCallback(cb, opts)
    : (cb) => window.setTimeout(cb, PERSIST_IDLE_TIMEOUT_MS);

const cancelIdle: (handle: number) => void =
  typeof cancelIdleCallback !== 'undefined'
    ? (handle) => cancelIdleCallback(handle)
    : (handle) => clearTimeout(handle);

function workspaceKey(workspaceUuid: string): string {
  return `${STORAGE_KEY_PREFIX}:${workspaceUuid}`;
}

async function flushIndexSave(workspaceUuid: string): Promise<void> {
  const index = memoryStore.get(workspaceKey(workspaceUuid));
  if (!index) return;
  await idbSet(workspaceUuid, index);
}

/**
 * Persist the in-memory index for a workspace, but defer the IndexedDB write
 * until the browser is idle. Multiple mutations within the debounce window
 * collapse into a single write, avoiding repeated JSON.stringify of the entire
 * index during editing bursts.
 */
function scheduleIndexSave(workspaceUuid: string): void {
  // If we already have a pending save for a different workspace, flush it
  // first so data does not leak across workspaces.
  if (pendingSaveWorkspaceUuid && pendingSaveWorkspaceUuid !== workspaceUuid) {
    const previous = pendingSaveWorkspaceUuid;
    pendingSaveWorkspaceUuid = workspaceUuid;
    clearSaveTimer();
    void flushIndexSave(previous).then(scheduleDebouncedSave);
    return;
  }

  pendingSaveWorkspaceUuid = workspaceUuid;
  if (saveTimer) return; // already scheduled

  scheduleDebouncedSave();
}

function scheduleDebouncedSave(): void {
  if (!pendingSaveWorkspaceUuid) return;
  if (saveTimer) return;

  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Prefer running during an idle period; if the browser does not support
    // requestIdleCallback, the setTimeout above already provided the delay.
    if (typeof requestIdleCallback !== 'undefined' && saveIdleHandle === null) {
      saveIdleHandle = scheduleIdle(
        () => {
          saveIdleHandle = null;
          const ws = pendingSaveWorkspaceUuid;
          pendingSaveWorkspaceUuid = null;
          if (ws) void flushIndexSave(ws);
        },
        { timeout: PERSIST_IDLE_TIMEOUT_MS },
      );
    } else if (saveIdleHandle === null) {
      const ws = pendingSaveWorkspaceUuid;
      pendingSaveWorkspaceUuid = null;
      if (ws) void flushIndexSave(ws);
    }
  }, PERSIST_DEBOUNCE_MS);
}

function clearSaveTimer(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (saveIdleHandle) {
    cancelIdle(saveIdleHandle);
    saveIdleHandle = null;
  }
}

/**
 * Synchronously flush any pending search-index write. Use on page hide / before
 * unload; the local index is a cache, so a missed write is acceptable.
 */
function flushPendingIndexSave(): void {
  const ws = pendingSaveWorkspaceUuid;
  if (!ws) return;
  clearSaveTimer();
  pendingSaveWorkspaceUuid = null;
  void flushIndexSave(ws);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushPendingIndexSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPendingIndexSave();
    }
  });
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

type SerializedIndex = ReturnType<MiniSearch<SearchDoc>['toJSON']>;

async function idbGet(workspaceUuid: string): Promise<MiniSearch<SearchDoc> | undefined> {
  const key = workspaceKey(workspaceUuid);
  if (hasIndexedDB) {
    // Store/load the index as a plain object using IndexedDB structured clone
    // instead of a JSON string. This avoids the main-thread JSON.parse cost
    // that blocked startup for large indexes.
    const data = await get<SerializedIndex | string>(key);
    if (!data) return undefined;
    // Old indexes may have been stored as JSON strings; parse those and then
    // load the plain object with loadJS. loadJSON always calls JSON.parse,
    // so it cannot accept the structured-clone object returned by toJSON().
    const js = typeof data === 'string' ? (JSON.parse(data) as SerializedIndex) : data;
    return MiniSearch.loadJS(js, {
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
    await set(key, index.toJSON());
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
    // Empty index does not need to be persisted immediately; the first mutation
    // will schedule a save.
    memoryStore.set(workspaceKey(workspaceUuid), index);
  } else {
    memoryStore.set(workspaceKey(workspaceUuid), index);
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
  await withIndexLock(workspaceUuid, async () => {
    const index = await getIndex(workspaceUuid);
    for (const node of nodes) {
      if (index.has(node.uuid)) {
        index.discard(node.uuid);
      }
    }
    index.addAll(nodes.map(nodeToDoc));
    scheduleIndexSave(workspaceUuid);
  });
}

/**
 * Remove nodes from the search index.
 */
export async function unindexNodes(
  workspaceUuid: string,
  nodeUuids: string[],
): Promise<void> {
  if (nodeUuids.length === 0) return;
  await withIndexLock(workspaceUuid, async () => {
    const index = await getIndex(workspaceUuid);
    for (const uuid of nodeUuids) {
      if (index.has(uuid)) {
        index.discard(uuid);
      }
    }
    scheduleIndexSave(workspaceUuid);
  });
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
  return withIndexLock(workspaceUuid, async () => {
    const index = await getIndex(workspaceUuid);
    if (!query.trim()) {
      // Empty query: return all indexed docs, filtered.
      const all = index.search('*');
      return all.filter((r) => matchesFilters(r as unknown as SearchDoc, filters));
    }
    const raw = index.search(query);
    return raw.filter((r) => matchesFilters(r as unknown as SearchDoc, filters));
  });
}

/**
 * Wipe the search index for a workspace.
 */
export async function clearSearchIndex(workspaceUuid: string): Promise<void> {
  await withIndexLock(workspaceUuid, async () => {
    if (pendingSaveWorkspaceUuid === workspaceUuid) {
      clearSaveTimer();
      pendingSaveWorkspaceUuid = null;
    }
    memoryStore.delete(workspaceKey(workspaceUuid));
    await idbDelete(workspaceUuid);
  });
}

/**
 * Reset the in-memory fallback. Intended for tests only.
 */
export function _resetMemoryIndex(): void {
  clearSaveTimer();
  pendingSaveWorkspaceUuid = null;
  memoryStore.clear();
}
