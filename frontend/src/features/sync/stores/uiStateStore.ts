/**
 * Local-only UI state store for sync-aware fold/zoom state.
 *
 * This state is NEVER synced between devices. It is keyed by
 * `(workspaceUuid, nodeUuid)` and persisted to IndexedDB so it survives
 * page reloads on the same device.
 */

import { create } from 'zustand';
import { get, set } from 'idb-keyval';

const STORAGE_KEY = 'notees-ui-state';

// In test environments (jsdom) IndexedDB is not available; fall back to memory.
const memoryStore = new Map<string, unknown>();
const hasIndexedDB = typeof indexedDB !== 'undefined';

async function idbGet<T>(key: string): Promise<T | undefined> {
  if (hasIndexedDB) return get<T>(key);
  return memoryStore.get(key) as T | undefined;
}

async function idbSet(key: string, value: unknown): Promise<void> {
  if (hasIndexedDB) {
    await set(key, value);
  } else {
    memoryStore.set(key, value);
  }
}

export interface NodeUIState {
  /** Whether the node's children are collapsed in the editor tree. */
  collapsed?: boolean;
  /** Zoom root for focused/nested editing; null means no zoom. */
  zoomRoot?: string | null;
}

interface UIStateStore {
  /** workspaceUuid -> nodeUuid -> NodeUIState */
  states: Record<string, Record<string, NodeUIState>>;

  /** Load persisted state from IndexedDB. Called once at app startup. */
  load(): Promise<void>;

  /** Get the UI state for a node in a workspace. */
  getNodeUIState(workspaceUuid: string, nodeUuid: string): NodeUIState | undefined;

  /** Set one or more fields of UI state for a node. */
  setNodeUIState(workspaceUuid: string, nodeUuid: string, patch: Partial<NodeUIState>): void;

  /** Toggle the collapsed flag for a node. */
  toggleCollapsed(workspaceUuid: string, nodeUuid: string): void;

  /** Set the collapsed flag explicitly. */
  setCollapsed(workspaceUuid: string, nodeUuid: string, collapsed: boolean): void;

  /** Remove all UI state for a workspace (e.g. on logout/reset). */
  clearWorkspace(workspaceUuid: string): void;
}

async function loadStored(): Promise<Record<string, Record<string, NodeUIState>>> {
  const value = await idbGet<Record<string, Record<string, NodeUIState>>>(STORAGE_KEY);
  if (value && typeof value === 'object') return value;
  return {};
}

async function saveStored(states: Record<string, Record<string, NodeUIState>>): Promise<void> {
  await idbSet(STORAGE_KEY, states);
}

export const useUIStateStore = create<UIStateStore>((set, get) => ({
  states: {},

  async load() {
    const states = await loadStored();
    set({ states });
  },

  getNodeUIState(workspaceUuid, nodeUuid) {
    return get().states[workspaceUuid]?.[nodeUuid];
  },

  setNodeUIState(workspaceUuid, nodeUuid, patch) {
    set((state) => {
      const workspace = state.states[workspaceUuid] ?? {};
      const current = workspace[nodeUuid] ?? {};
      const next = { ...workspace, [nodeUuid]: { ...current, ...patch } };
      const nextStates = { ...state.states, [workspaceUuid]: next };
      void saveStored(nextStates);
      return { states: nextStates };
    });
  },

  toggleCollapsed(workspaceUuid, nodeUuid) {
    const current = get().getNodeUIState(workspaceUuid, nodeUuid);
    get().setNodeUIState(workspaceUuid, nodeUuid, { collapsed: !(current?.collapsed ?? false) });
  },

  setCollapsed(workspaceUuid, nodeUuid, collapsed) {
    get().setNodeUIState(workspaceUuid, nodeUuid, { collapsed });
  },

  clearWorkspace(workspaceUuid) {
    set((state) => {
      if (!(workspaceUuid in state.states)) return state;
      const next = { ...state.states };
      delete next[workspaceUuid];
      void saveStored(next);
      return { states: next };
    });
  },
}));
