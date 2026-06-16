/**
 * Sync layer public API.
 *
 * The sync layer is the only part of the frontend that talks to the API.
 * It adapts OperationRuntime operations to TanStack Query mutations.
 */

export { SyncManager } from './SyncManager';
export { applyCacheUpdate, executeOperation, operationToApiRequest, defaultSyncApi } from './mutationMap';
export { intentToOperations, contentOperation, createOperation, moveOperation, deleteOperation, collapsedOperation } from './intents';
export type { SyncApi } from './mutationMap';
export { writeCreate, writeUpdate, writeDelete, writeMove } from './cacheWriter';
export type { NodePatch } from './cacheWriter';
