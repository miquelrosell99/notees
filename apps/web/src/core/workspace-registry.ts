/**
 * workspace-registry — the device-local workspace registry (offline chrome).
 *
 * The workspace list (ids, names, roles) lives server-side; it is not op-log
 * data, so the derived stores intentionally don't carry it. An offline
 * session still needs it, though: which workspaces exist, what they're
 * called, and which of them hold a synced copy on this device. This module
 * persists exactly that and serves it as the fallback for the workspace
 * switcher and the manager when the server can't answer.
 *
 * Two stores, both device-local like the rest of the remembered session
 * (cleared with site data):
 *
 * - `notees.workspaces` — the last server list seen, replaced wholesale on
 *   every successful fetch (the server is authoritative while reachable).
 * - `notees.localWorkspaces` — ids this device has booted at least once: a
 *   superset proxy for "has a local OPFS copy" (the worker store is keyed by
 *   workspace id, so booting persists one).
 *
 * Honesty bounds: an entry can linger after a server-side delete until the
 * next successful list fetch, and a remembered workspace without a local
 * copy is not offered offline — there is nothing on this device to open.
 */

import type { WorkspaceEntry } from "./auth-api.js";

const WORKSPACES_KEY = "notees.workspaces";
const LOCAL_COPIES_KEY = "notees.localWorkspaces";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode); the registry just won't persist.
  }
}

/** Replace the remembered list — called whenever the server list arrives. */
export function rememberWorkspaceList(list: readonly WorkspaceEntry[]): void {
  writeJson(WORKSPACES_KEY, [...list]);
}

/** Update one remembered entry's name (server-side rename). */
export function rememberWorkspaceName(workspaceId: string, name: string): void {
  const list = rememberedWorkspaceList().map((ws) =>
    ws.id === workspaceId ? { ...ws, name } : ws,
  );
  writeJson(WORKSPACES_KEY, list);
}

/** The last server list seen ([] when nothing is remembered). */
export function rememberedWorkspaceList(): WorkspaceEntry[] {
  const list = readJson<unknown>(WORKSPACES_KEY, []);
  return Array.isArray(list) ? (list as WorkspaceEntry[]) : [];
}

/** The remembered name for a workspace, or null when unknown/unnamed. */
export function rememberedWorkspaceName(workspaceId: string): string | null {
  const entry = rememberedWorkspaceList().find((ws) => ws.id === workspaceId);
  return entry !== undefined && entry.name !== null && entry.name !== "" ? entry.name : null;
}

/** Record that this device holds a synced copy of the workspace. */
export function markLocalWorkspaceCopy(workspaceId: string): void {
  const copies = new Set(localWorkspaceCopies());
  copies.add(workspaceId);
  writeJson(LOCAL_COPIES_KEY, [...copies]);
}

/** Workspace ids this device has a local copy of. */
export function localWorkspaceCopies(): ReadonlySet<string> {
  const list = readJson<unknown>(LOCAL_COPIES_KEY, []);
  return new Set(Array.isArray(list) ? (list as string[]) : []);
}

/**
 * The honest offline answer: remembered workspaces that actually hold a
 * local copy on this device — the only ones that can be opened offline.
 */
export function offlineWorkspaceList(): WorkspaceEntry[] {
  const copies = localWorkspaceCopies();
  return rememberedWorkspaceList().filter((ws) => copies.has(ws.id));
}
