export { Clock, compareHlc, maxHlc } from './clock';
export type { Hlc } from './clock';
export { uuidv7 } from './uuid';
export { TextCrdt, textOperationPayload } from './crdt/text';
export { TreeCrdt, treeOperationPayload } from './crdt/tree';
export { createOperation, validateOperation } from './types/operation';
export type { Operation, OperationEnvelope } from './types/operation';
export { createSchema } from './db/schema';
export { createDatabase, openWorkspaceDatabase } from './db/connection';
export { WorkspaceStore } from './store';
export type { NodeRow } from './store';
export { SyncEngine } from './sync';
export type { SyncEngineCallbacks, SyncPullProgress, SyncStatus } from './sync';
export { MemoryRelay, MemoryTransport } from './transport';
export type { Transport } from './transport';
export { encryptEnvelope, decryptEnvelope } from './crypto';
export type { OperationEnvelope as RelayEnvelope } from './crypto';

// Phase 4 D1 local-first hooks, adapter, and persistence
export {
  WorkspaceStoreProvider,
  WorkspaceStoreContext,
  useWorkspaceStore,
  useWorkspaceStoreClient,
  useNode,
  useNodes,
  useChildren,
  useCreateNode,
  useUpdateText,
  useMoveNode,
  useDeleteNode,
  useSync,
} from './hooks';
export type {
  WorkspaceStoreProviderProps,
  WorkspaceStoreContextValue,
  UseWorkspaceStoreResult,
  UseWorkspaceStoreClientResult,
  UseNodeResult,
  UseNodesResult,
  UseChildrenResult,
  CreateNodeArgs,
  UseCreateNodeResult,
  UseUpdateTextResult,
  UseMoveNodeResult,
  UseDeleteNodeResult,
  UseSyncResult,
} from './hooks';
export {
  getOrCreateWorkspaceStore,
  getWorkspaceStore,
  getWorkspaceSyncEngine,
  closeWorkspaceStore,
  syncWorkspace,
} from './adapters/workspaceStoreAdapter';
export {
  getOrCreateWorkspaceStoreClient,
  getWorkspaceStoreClient,
  getActiveWorkspaceStoreClient,
  closeWorkspaceStoreClient,
} from './adapters/workspaceStoreClientAdapter';
export {
  saveWorkspaceDatabase,
  loadWorkspaceDatabase,
  deleteWorkspaceDatabase,
} from './persistence/indexedDb';
export {
  queueOperation,
  drainQueuedOperations,
  clearQueuedOperations,
} from './persistence/operationQueue';
export { ENABLE_SQLITE_STORE } from './utils/featureFlags';
