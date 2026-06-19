/**
 * Operation types and state machine for the pure OperationRuntime.
 *
 * This module has no React, TanStack Query, or API imports.
 * It defines the canonical shape of local mutations and their lifecycle.
 */

import type { ASTDocument } from '@/types/ast';
import type { GraphNodeType } from './types';

// ─── Operation state machine ─────────────────────────────────────

export type OperationState = 'pending' | 'in_flight' | 'acknowledged' | 'failed';

// ─── Core node snapshot used by the reducer ──────────────────────

/**
 * The minimal node shape the operation reducer needs.
 * Projection code maps this to/from the full GraphNode / API Node types.
 */
export interface CoreNode {
  blockId: string;
  serverId?: number;
  parentId: string | null;
  orderIndex: number;
  nodeType: GraphNodeType;
  contentAST: ASTDocument;
  collapsed: boolean;
  isDeleted: boolean;
  isPage: boolean;
  name?: string;
  icon?: string | null;
  color?: string | null;
  classIds: string[];
  tagIds: string[];
  isPrivate?: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  hasServerChildren?: boolean;
  calloutType?: string | null;
  taskStatus?: string | null;
}

// ─── Operation payloads ──────────────────────────────────────────

export interface UpdateContentPayload {
  contentAST: ASTDocument;
}

export interface MovePayload {
  parentId: string | null;
  afterBlockId: string | null;
}

export interface CreatePayload {
  parentId: string | null;
  afterBlockId: string | null;
  contentAST: ASTDocument;
  nodeType?: GraphNodeType;
  name?: string;
  icon?: string | null;
  color?: string | null;
  classIds?: string[];
  tagIds?: string[];
}

export interface DeletePayload {
  /** If true, permanently remove from local state after ack. */
  permanent?: boolean;
}

export interface SetCollapsedPayload {
  collapsed: boolean;
}

export interface SetClassesPayload {
  classIds: string[];
}

export interface SetTagsPayload {
  tagIds: string[];
}

export interface AddClassPayload {
  classId: string;
}

export interface RemoveClassPayload {
  classId: string;
}

export interface AddTagPayload {
  tagId: string;
}

export interface RemoveTagPayload {
  tagId: string;
}

export interface UpdateNodePayload {
  updates: Partial<CoreNode>;
}

export interface MoveNodePayload {
  parentId: string | null;
  afterBlockId: string | null;
}

// ─── Operation union ─────────────────────────────────────────────

export type OperationType =
  | 'update_content'
  | 'move'
  | 'create'
  | 'delete'
  | 'set_collapsed'
  | 'set_classes'
  | 'set_tags'
  | 'add_class'
  | 'remove_class'
  | 'add_tag'
  | 'remove_tag'
  | 'update_node'
  | 'move_node';

export interface Operation {
  readonly id: string;
  readonly type: OperationType;
  readonly blockId: string;
  readonly serverId?: number;
  readonly payload:
    | UpdateContentPayload
    | MovePayload
    | CreatePayload
    | DeletePayload
    | SetCollapsedPayload
    | SetClassesPayload
    | SetTagsPayload
    | AddClassPayload
    | RemoveClassPayload
    | AddTagPayload
    | RemoveTagPayload
    | UpdateNodePayload
    | MoveNodePayload;
  readonly state: OperationState;
  readonly dependsOn: readonly string[];
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly createdAt: number;
  readonly error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

export function isPending(operation: Operation): boolean {
  return operation.state === 'pending';
}

export function isInFlight(operation: Operation): boolean {
  return operation.state === 'in_flight';
}

export function isAcknowledged(operation: Operation): boolean {
  return operation.state === 'acknowledged';
}

export function isFailed(operation: Operation): boolean {
  return operation.state === 'failed';
}

export function canRetry(operation: Operation): boolean {
  return operation.retryCount < operation.maxRetries;
}

export function withState(operation: Operation, state: OperationState, patch?: Partial<Operation>): Operation {
  return { ...operation, state, ...patch };
}

export function withInFlight(operation: Operation): Operation {
  return withState(operation, 'in_flight');
}

export function withAcknowledged(operation: Operation): Operation {
  return withState(operation, 'acknowledged');
}

export function withFailed(operation: Operation, error: string): Operation {
  return withState(operation, 'failed', { error, retryCount: operation.retryCount + 1 });
}

export function withRetry(operation: Operation): Operation {
  return withState(operation, 'pending', { error: undefined, retryCount: operation.retryCount + 1 });
}
