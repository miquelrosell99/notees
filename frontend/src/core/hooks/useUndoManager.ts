import { useMemo } from 'react';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';
import type { UndoEntry, UndoListener } from '../undo';

type CreateNodeArgs = Parameters<WorkspaceStore['createNode']>[0];
type SetPropertyArgs = Parameters<WorkspaceStore['setProperty']>[0];
type UnsetPropertyArgs = Parameters<WorkspaceStore['unsetProperty']>[0];

/**
 * Async facade over the worker-owned UndoManager.
 *
 * The real UndoManager lives in the workspace Web Worker and operates on the
 * worker-owned WorkspaceStore. This object exposes the same public shape but
 * returns Promises, forwarding record-* operations through the async client.
 */
export interface UndoManagerClient {
  createNode(args: CreateNodeArgs): Promise<void>;
  createBlock(args: CreateNodeArgs & { content?: string }): Promise<void>;
  deleteNode(nodeId: string): Promise<void>;
  moveNode(nodeId: string, newParentId: string | null): Promise<void>;
  mergeBlocks(sourceBlockId: string, targetBlockId: string): Promise<void>;
  setProperty(args: SetPropertyArgs): Promise<void>;
  unsetProperty(args: UnsetPropertyArgs): Promise<void>;
  assignClass(nodeId: string, classId: string): Promise<void>;
  unassignClass(nodeId: string, classId: string): Promise<void>;
  recordSetNodeText(nodeId: string, value: string): Promise<void>;
  undo(): Promise<UndoEntry | null>;
  redo(): Promise<UndoEntry | null>;
  canUndo(): Promise<boolean>;
  canRedo(): Promise<boolean>;
  clear(): Promise<void>;
  getStacks(): Promise<{ undo: UndoEntry[]; redo: UndoEntry[] }>;
  subscribe(listener: UndoListener): () => void;
}

export function createUndoManagerClient(client: IWorkspaceStoreClient): UndoManagerClient {
  return {
    createNode: (args) => client.mutate<void>('recordCreateNode', [args]),
    createBlock: (args) => client.mutate<void>('recordCreateBlock', [args]),
    deleteNode: (nodeId) => client.mutate<void>('recordDeleteNode', [nodeId]),
    moveNode: (nodeId, newParentId) => client.mutate<void>('recordMoveNode', [nodeId, newParentId]),
    mergeBlocks: (sourceBlockId, targetBlockId) =>
      client.mutate<void>('recordMergeBlocks', [sourceBlockId, targetBlockId]),
    setProperty: (args) => client.mutate<void>('recordSetProperty', [args]),
    unsetProperty: (args) => client.mutate<void>('recordUnsetProperty', [args]),
    assignClass: (nodeId, classId) => client.mutate<void>('recordAssignClass', [nodeId, classId]),
    unassignClass: (nodeId, classId) => client.mutate<void>('recordUnassignClass', [nodeId, classId]),
    recordSetNodeText: (nodeId, value) => client.mutate<void>('recordSetNodeText', [nodeId, value]),
    undo: () => client.mutate<UndoEntry | null>('undo', []),
    redo: () => client.mutate<UndoEntry | null>('redo', []),
    clear: () => client.mutate<void>('clearUndoHistory', []),
    canUndo: async () => {
      const result = await client.query<{ canUndo: boolean; canRedo: boolean }>('canUndo', []);
      return result.canUndo;
    },
    canRedo: async () => {
      const result = await client.query<{ canUndo: boolean; canRedo: boolean }>('canUndo', []);
      return result.canRedo;
    },
    getStacks: () => client.query<{ undo: UndoEntry[]; redo: UndoEntry[] }>('getUndoStacks', []),
    subscribe: (listener) => client.subscribe(null, () => listener({ type: 'stack_changed' })),
  };
}

/**
 * Return an async UndoManager facade for the current workspace.
 *
 * The facade talks to the worker-owned UndoManager through the async store
 * client. It is undefined while the client is still initializing.
 */
export function useUndoManager(workspaceId: string): UndoManagerClient | undefined {
  const { client } = useWorkspaceStoreClient(workspaceId);

  return useMemo(() => {
    if (!client) return undefined;
    return createUndoManagerClient(client);
  }, [client]);
}
