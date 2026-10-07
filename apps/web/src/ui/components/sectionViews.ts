/**
 * sectionViews — the per-user hosted-views store (custom tabs on
 * collection-backed sections).
 *
 * Same ruling as nodePrefs: custom views are cross-device UI state, so the
 * server-side per-user prefs store is the authority
 * (`GET/POST/PATCH/PUT/DELETE /api/me/nodes/:nodeId/sections/:sectionKey/views`)
 * and the operation log stays untouched ("device state is never an op"). This
 * module is the main-thread bridge, shaped on the nodePrefs precedent:
 *
 *  - one shared in-memory copy per (node, section), so every tab bar for the
 *    same section reads the same list without duplicate GETs;
 *  - boot: `ensureSectionViewsLoaded` fetches the server copy once per section
 *    and writes it through to the device-local cache, so offline reads answer
 *    from the last synced copy (`loaded` says which side answered);
 *  - mutations are optimistic on the shared copy and confirmed by the server
 *    call. A failed write REVERTS the optimistic row and warns: unlike the
 *    favorites/recents full-list replace (where a local list re-pushed later
 *    converges wholesale), per-row offline writes cannot be replayed
 *    honestly — an offline delete that never reached the server would
 *    resurrect on the next load. Offline, hosted views are read-only;
 *  - the default view is derived-not-stored (no row, no is_default): the
 *    server table empty for a section IS factory behavior.
 */

import { useEffect, useState } from "react";

import type { SectionView } from "@/core/workspace-client.js";

/** The views seam both client classes satisfy (structural — tests can fake it). */
export interface SectionViewsClient {
  listSectionViews(nodeId: string, sectionKey: string): Promise<SectionView[]>;
  createSectionView(input: {
    nodeId: string;
    sectionKey: string;
    name: string;
    queryAst: unknown;
    viewMode?: string | null;
  }): Promise<SectionView>;
  renameSectionView(
    nodeId: string,
    sectionKey: string,
    viewId: string,
    name: string,
  ): Promise<SectionView>;
  reorderSectionViews(
    nodeId: string,
    sectionKey: string,
    orderedIds: string[],
  ): Promise<SectionView[]>;
  deleteSectionView(nodeId: string, sectionKey: string, viewId: string): Promise<void>;
}

export interface SectionViewsState {
  /** The section's custom views in tab order (default tab NOT included — derived). */
  views: SectionView[];
  /** False until the first load resolved (server or device fallback). */
  loaded: boolean;
  /** The last failed write's message (409/offline), for the chrome to surface. */
  lastWriteError: string | null;
}

export const SECTION_VIEWS_LOCAL_KEY = "notees.sectionViews.v1";

/** React subscribers + the shared per-section copies. */
const listeners = new Set<() => void>();
const cache = new Map<string, SectionView[]>();
const loadedKeys = new Set<string>();
const inflight = new Map<string, Promise<void>>();
let lastWriteError: string | null = null;

function writeFailed(kind: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  lastWriteError = `${kind} failed: ${detail}`;
  notify();
  console.warn(`[section-views] ${lastWriteError}`);
}

function writeSucceeded(): void {
  if (lastWriteError !== null) {
    lastWriteError = null;
    notify();
  }
}

function cacheKey(nodeId: string, sectionKey: string): string {
  return `${nodeId}|${sectionKey}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

// --- device-local cache (the honest offline read) -----------------------------

function readDeviceCache(): Record<string, SectionView[]> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(SECTION_VIEWS_LOCAL_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, SectionView[]>;
  } catch {
    return {};
  }
}

function writeDeviceEntry(key: string, views: SectionView[]): void {
  cache.set(key, views);
  if (typeof localStorage === "undefined") return;
  try {
    const all = readDeviceCache();
    all[key] = views;
    localStorage.setItem(SECTION_VIEWS_LOCAL_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the in-memory copy keeps the session consistent.
  }
}

// --- load ----------------------------------------------------------------------

/**
 * Boot-time load, idempotent per (client, section): fetch the server copy
 * once and make it the shared truth (device-cached for offline reads). A
 * client without the views seam (hand-rolled test doubles) or a failed fetch
 * leaves the device copy standing, loaded from cache.
 */
export function ensureSectionViewsLoaded(
  client: SectionViewsClient,
  nodeId: string,
  sectionKey: string,
): void {
  const key = cacheKey(nodeId, sectionKey);
  if (loadedKeys.has(key) || inflight.has(key)) return;
  if (typeof client.listSectionViews !== "function") {
    if (!cache.has(key)) cache.set(key, readDeviceCache()[key] ?? []);
    loadedKeys.add(key);
    notify();
    return;
  }
  const request: Promise<void> = client
    .listSectionViews(nodeId, sectionKey)
    .then((views) => {
      writeDeviceEntry(key, views);
      loadedKeys.add(key);
      notify();
    })
    .catch((error: unknown) => {
      // Offline/unreachable: the last synced device copy is the honest answer.
      if (!cache.has(key)) cache.set(key, readDeviceCache()[key] ?? []);
      loadedKeys.add(key);
      notify();
      console.warn(`[section-views] load failed for ${key}; device cache stands:`, error);
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
}

// --- mutations -------------------------------------------------------------------
//
// Each mutation applies the optimistic row(s) to the shared copy, then calls
// the server. On failure the optimistic state is reverted and the error
// rethrown for the chrome to surface — a write that did not reach the server
// must not pretend it did (see the header: offline, views are read-only).

function current(nodeId: string, sectionKey: string): SectionView[] {
  return cache.get(cacheKey(nodeId, sectionKey)) ?? [];
}

function apply(nodeId: string, sectionKey: string, views: SectionView[]): void {
  writeDeviceEntry(cacheKey(nodeId, sectionKey), views);
  notify();
}

function nextSequence(views: readonly SectionView[]): number {
  return views.reduce((max, view) => Math.max(max, view.sequence), -1) + 1;
}

/** Create a view (appended). Resolves the server row, or null when the write failed. */
export async function createSectionView(
  client: SectionViewsClient | null,
  nodeId: string,
  sectionKey: string,
  input: { name: string; queryAst: unknown; viewMode?: string | null },
): Promise<SectionView | null> {
  if (client === null) return null;
  const before = current(nodeId, sectionKey);
  const optimistic: SectionView = {
    id: `optimistic-${Math.random().toString(36).slice(2)}`,
    nodeId,
    sectionKey,
    name: input.name,
    sequence: nextSequence(before),
    queryAst: input.queryAst,
    viewMode: input.viewMode ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  apply(nodeId, sectionKey, [...before, optimistic]);
  try {
    const view = await client.createSectionView({ nodeId, sectionKey, ...input });
    // Replace the optimistic row at its position (the server is sequence authority).
    const now = current(nodeId, sectionKey).map((entry) => (entry.id === optimistic.id ? view : entry));
    apply(nodeId, sectionKey, now);
    writeSucceeded();
    return view;
  } catch (error) {
    apply(nodeId, sectionKey, before);
    writeFailed("create view", error);
    return null;
  }
}

/** Rename a view. Resolves false when the write failed (caller surfaces it). */
export async function renameSectionView(
  client: SectionViewsClient | null,
  nodeId: string,
  sectionKey: string,
  viewId: string,
  name: string,
): Promise<boolean> {
  if (client === null) return false;
  const before = current(nodeId, sectionKey);
  apply(
    nodeId,
    sectionKey,
    before.map((view) => (view.id === viewId ? { ...view, name, updatedAt: Date.now() } : view)),
  );
  try {
    const view = await client.renameSectionView(nodeId, sectionKey, viewId, name);
    apply(nodeId, sectionKey, current(nodeId, sectionKey).map((entry) => (entry.id === viewId ? view : entry)));
    writeSucceeded();
    return true;
  } catch (error) {
    apply(nodeId, sectionKey, before);
    writeFailed("rename view", error);
    return false;
  }
}

/** Reorder the section's tabs (the full ordered id list). False when the write failed. */
export async function reorderSectionViews(
  client: SectionViewsClient | null,
  nodeId: string,
  sectionKey: string,
  orderedIds: string[],
): Promise<boolean> {
  if (client === null) return false;
  const before = current(nodeId, sectionKey);
  const position = new Map(orderedIds.map((id, index) => [id, index]));
  apply(
    nodeId,
    sectionKey,
    [...before]
      .map((view) => ({ view, index: position.get(view.id) }))
      .filter((entry): entry is { view: SectionView; index: number } => entry.index !== undefined)
      .sort((a, b) => a.index - b.index)
      .map((entry, index) => ({ ...entry.view, sequence: index })),
  );
  try {
    const views = await client.reorderSectionViews(nodeId, sectionKey, orderedIds);
    apply(nodeId, sectionKey, views);
    writeSucceeded();
    return true;
  } catch (error) {
    apply(nodeId, sectionKey, before);
    writeFailed("reorder views", error);
    return false;
  }
}

/** Delete a view. False when the write failed. */
export async function deleteSectionView(
  client: SectionViewsClient | null,
  nodeId: string,
  sectionKey: string,
  viewId: string,
): Promise<boolean> {
  if (client === null) return false;
  const before = current(nodeId, sectionKey);
  apply(nodeId, sectionKey, before.filter((view) => view.id !== viewId));
  try {
    await client.deleteSectionView(nodeId, sectionKey, viewId);
    writeSucceeded();
    return true;
  } catch (error) {
    apply(nodeId, sectionKey, before);
    writeFailed("delete view", error);
    return false;
  }
}

/** Test seam: reset the module store (clears caches + loaded keys). */
export function resetSectionViewsForTests(): void {
  cache.clear();
  loadedKeys.clear();
  inflight.clear();
}

// --- hook ------------------------------------------------------------------------

/** The hook: every surface for the same section reads the same shared copy. */
export function useSectionViews(
  client: SectionViewsClient | null,
  nodeId: string,
  sectionKey: string,
): SectionViewsState & { createView: typeof createSectionView } {
  const key = cacheKey(nodeId, sectionKey);
  const [state, setState] = useState<SectionViewsState>({
    views: cache.get(key) ?? [],
    loaded: loadedKeys.has(key),
    lastWriteError,
  });
  useEffect(() => {
    const refresh = () =>
      setState({
        views: cache.get(key) ?? [],
        loaded: loadedKeys.has(key),
        lastWriteError,
      });
    listeners.add(refresh);
    if (client !== null) ensureSectionViewsLoaded(client, nodeId, sectionKey);
    refresh();
    return () => {
      listeners.delete(refresh);
    };
  }, [client, nodeId, sectionKey, key]);
  return { ...state, createView: createSectionView };
}
