/**
 * Message protocol for the workspace Web Worker.
 *
 * The worker is the sole owner of the sql.js Database. The main thread sends
 * requests and the worker replies with results, errors, or change notifications.
 */

import type { WorkspaceStore } from '../store';

// ─── Requests (main → worker) ───────────────────────────────────────────────

export interface InitRequest {
  type: 'init';
  id: number;
  workspaceId: string;
  actorId: string;
  /** Persisted database bytes, if any. */
  dbBytes?: Uint8Array;
}

export interface ExportRequest {
  type: 'export';
  id: number;
}

export interface CloseRequest {
  type: 'close';
}

export interface MutateRequest {
  type: 'mutate';
  id: number;
  method: string;
  args: unknown[];
}

export interface QueryRequest {
  type: 'query';
  id: number;
  method: string;
  args: unknown[];
}

export type WorkerRequest =
  | InitRequest
  | ExportRequest
  | CloseRequest
  | MutateRequest
  | QueryRequest;

// ─── Responses (worker → main) ──────────────────────────────────────────────

export interface InitDoneResponse {
  type: 'init-done';
  id: number;
}

export interface ExportResultResponse {
  type: 'export-result';
  id: number;
  bytes: Uint8Array;
}

export interface WorkerErrorResponse {
  type: 'error';
  id: number;
  message: string;
}

export interface MutateDoneResponse {
  type: 'mutate-done';
  id: number;
  result: unknown;
}

export interface QueryResultResponse {
  type: 'query-result';
  id: number;
  result: unknown;
}

export type WorkerResponse =
  | InitDoneResponse
  | ExportResultResponse
  | MutateDoneResponse
  | QueryResultResponse
  | WorkerErrorResponse;

// ─── Notifications (worker → main, no id) ───────────────────────────────────

export interface NotifyChangeMessage {
  type: 'notify';
  /** Undefined means "something changed, re-run open subscriptions". */
  nodeId?: string;
}

export type WorkerMessage = WorkerResponse | NotifyChangeMessage;

// ─── Client interface (lives here to avoid circular imports) ────────────────

export interface IWorkspaceStoreClient {
  init(workspaceId: string, actorId: string, options?: { dbBytes?: Uint8Array; store?: WorkspaceStore }): Promise<void>;
  export(): Promise<Uint8Array>;
  mutate<T>(method: string, args: unknown[]): Promise<T>;
  query<T>(method: string, args: unknown[]): Promise<T>;
  subscribe(nodeId: string | null, callback: () => void): () => void;
  close(): void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let nextRequestId = 1;

export function generateRequestId(): number {
  return nextRequestId++;
}
