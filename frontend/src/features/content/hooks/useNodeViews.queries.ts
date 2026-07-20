/**
 * NodeView Query Hooks
 *
 * Reads view definitions from the local-first core SQLite store. Query
 * execution itself is delegated to the SQLite QueryAST adapters.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { NodeView, QueryExecuteRequest } from '@/types/nodeView';
import type { QueryAST } from '@/types';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { queryAll, queryOne } from '@/core/db/sqlite';
import { compileToSqlite } from '@/core/query/compileToSqlite';
import { substituteRuntimeParams } from '@/core/query/substituteRuntimeParams';
import {
  useExecuteQueryAdapter,
  useQueryResultsAdapter,
} from '@/core/adapters/useQueryAstAdapter';
export { nodeViewKeys } from '@/hooks/queryKeys';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToNodeView(row: {
  id: string;
  node_id: string;
  name: string;
  view_type: string;
  order_index: number;
  is_default: number;
  active: number;
  shown_properties: string;
  group_by: string | null;
  view_mode: string | null;
  sort_entries: string;
  settings: string;
  query_ast: string | null;
  created_at: string | null;
  updated_at: string | null;
}): NodeView {
  return {
    uuid: row.id,
    node_uuid: row.node_id,
    name: row.name,
    view_type: row.view_type,
    order_index: row.order_index,
    is_default: row.is_default !== 0,
    active: row.active !== 0,
    shown_properties: parseJson<Array<{ uuid: string; sequence: number }>>(row.shown_properties, []),
    group_by: parseJson<NodeView['group_by']>(row.group_by, null),
    view_mode: row.view_mode as NodeView['view_mode'],
    sort_entries: parseJson<NodeView['sort_entries']>(row.sort_entries, []),
    settings: parseJson<NodeView['settings']>(row.settings, {}),
    query_ast: parseJson<QueryAST | undefined>(row.query_ast, undefined),
    create_date: row.created_at ?? new Date().toISOString(),
    write_date: row.updated_at ?? new Date().toISOString(),
  };
}

// ==================== Query Hooks ====================

/**
 * Fetch NodeViews for a node from the core store.
 */
export function useNodeViews(
  nodeUuid: string,
  options?: {
    viewType?: string;
    enabled?: boolean;
    includeQueryAST?: boolean;
  }
) {
  const { viewType, enabled = true, includeQueryAST = true } = options ?? {};
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(enabled && workspaceId ? workspaceId : '');
  const [data, setData] = useState<NodeView[]>([]);
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!store || !nodeUuid) {
      setData([]);
      return;
    }

    const update = (): void => {
      const sql = viewType
        ? `SELECT * FROM node_view WHERE node_id = ? AND view_type = ? AND active = 1 ORDER BY order_index`
        : `SELECT * FROM node_view WHERE node_id = ? AND active = 1 ORDER BY order_index`;
      const params = viewType ? [nodeUuid, viewType] : [nodeUuid];
      const rows = queryAll<{
        id: string;
        node_id: string;
        name: string;
        view_type: string;
        order_index: number;
        is_default: number;
        active: number;
        shown_properties: string;
        group_by: string | null;
        view_mode: string | null;
        sort_entries: string;
        settings: string;
        query_ast: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>(store.getDb(), sql, params);

      const views = rows.map(rowToNodeView);
      if (!includeQueryAST) {
        setData(views.map((v) => ({ ...v, query_ast: undefined })));
      } else {
        setData(views);
      }
    };

    update();
    return store.subscribeAll(update);
  }, [store, nodeUuid, viewType, includeQueryAST, tick]);

  return {
    data,
    isLoading: storeLoading,
    isError: storeError !== null,
    error: storeError,
    refetch,
  };
}

/**
 * Fetch NodeViews grouped by view_type from the core store.
 */
export function useNodeViewsByType(
  nodeUuid: string,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(enabled && workspaceId ? workspaceId : '');
  const [data, setData] = useState<Record<string, NodeView[]>>({});

  useEffect(() => {
    if (!store || !nodeUuid) {
      setData({});
      return;
    }

    const update = (): void => {
      const rows = queryAll<{
        id: string;
        node_id: string;
        name: string;
        view_type: string;
        order_index: number;
        is_default: number;
        active: number;
        shown_properties: string;
        group_by: string | null;
        view_mode: string | null;
        sort_entries: string;
        settings: string;
        query_ast: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>(
        store.getDb(),
        `SELECT * FROM node_view WHERE node_id = ? AND active = 1 ORDER BY order_index`,
        [nodeUuid]
      );

      const grouped: Record<string, NodeView[]> = {};
      for (const row of rows) {
        const view = rowToNodeView(row);
        if (!grouped[view.view_type]) {
          grouped[view.view_type] = [];
        }
        grouped[view.view_type].push(view);
      }
      for (const viewType of Object.keys(grouped)) {
        grouped[viewType].sort((a, b) => a.order_index - b.order_index);
      }
      setData(grouped);
    };

    update();
    return store.subscribeAll(update);
  }, [store, nodeUuid]);

  return {
    data,
    isLoading: storeLoading,
    isError: storeError !== null,
    error: storeError,
  };
}

/**
 * Fetch a single NodeView by ID from the core store.
 */
export function useNodeView(
  viewId: string | number,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};
  const viewUuid = typeof viewId === 'string' ? viewId : null;
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(enabled && workspaceId ? workspaceId : '');
  const [data, setData] = useState<NodeView | undefined>(undefined);

  useEffect(() => {
    if (!store || !viewUuid) {
      setData(undefined);
      return;
    }

    const update = (): void => {
      const row = queryOne<{
        id: string;
        node_id: string;
        name: string;
        view_type: string;
        order_index: number;
        is_default: number;
        active: number;
        shown_properties: string;
        group_by: string | null;
        view_mode: string | null;
        sort_entries: string;
        settings: string;
        query_ast: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>(store.getDb(), `SELECT * FROM node_view WHERE id = ?`, [viewUuid]);
      setData(row ? rowToNodeView(row) : undefined);
    };

    update();
    return store.subscribeAll(update);
  }, [store, viewUuid]);

  return {
    data,
    isLoading: storeLoading,
    isError: storeError !== null,
    error: storeError,
  };
}

/**
 * Fetch the default NodeView for a view_type from the core store.
 */
export function useDefaultNodeView(
  nodeUuid: string,
  viewType: string,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(enabled && workspaceId ? workspaceId : '');
  const [data, setData] = useState<NodeView | undefined>(undefined);

  useEffect(() => {
    if (!store || !nodeUuid || !viewType) {
      setData(undefined);
      return;
    }

    const update = (): void => {
      const row = queryOne<{
        id: string;
        node_id: string;
        name: string;
        view_type: string;
        order_index: number;
        is_default: number;
        active: number;
        shown_properties: string;
        group_by: string | null;
        view_mode: string | null;
        sort_entries: string;
        settings: string;
        query_ast: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>(
        store.getDb(),
        `SELECT * FROM node_view WHERE node_id = ? AND view_type = ? AND is_default = 1 AND active = 1`,
        [nodeUuid, viewType]
      );
      setData(row ? rowToNodeView(row) : undefined);
    };

    update();
    return store.subscribeAll(update);
  }, [store, nodeUuid, viewType]);

  return {
    data,
    isLoading: storeLoading,
    isError: storeError !== null,
    error: storeError,
  };
}

/**
 * Execute a saved NodeView query using the local-first QueryAST adapter.
 */
export function useNodeViewQuery(
  viewId: string | number,
  options?: {
    runtimeParams?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    orderBy?: string;
    includeChildren?: boolean;
    includeAllChildren?: boolean;
    pagesOnly?: boolean;
    includeProperties?: boolean;
    enrich?: { children?: boolean; classes?: boolean; properties?: boolean };
    enabled?: boolean;
    ast?: QueryAST;
  }
) {
  return useQueryResultsAdapter(viewId, options);
}

/**
 * Execute an ad-hoc query using the local-first QueryAST adapter.
 */
export function useQuery_(
  request: QueryExecuteRequest,
  options?: {
    enabled?: boolean;
    queryKey?: readonly unknown[];
  }
) {
  return useExecuteQueryAdapter(request, options);
}

/**
 * Count query results locally by compiling the AST and running SELECT COUNT(*).
 */
export function useQueryCount(
  request: QueryExecuteRequest,
  options?: {
    enabled?: boolean;
  }
): UseQueryResult<number, Error> {
  const { enabled = true } = options ?? {};
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(enabled && workspaceId ? workspaceId : '');
  const [data, setData] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const runtimeParamsKey = JSON.stringify(request.runtime_params);

  useEffect(() => {
    if (!enabled || !store || !workspaceId || !request.query_ast) {
      setData(0);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const ast = substituteRuntimeParams(request.query_ast as QueryAST, request.runtime_params ?? {});
      const compiled = compileToSqlite(ast, workspaceId);
      const row = queryOne<{ count: number }>(
        store.getDb(),
        `SELECT COUNT(*) AS count FROM (${compiled.sql})`,
        compiled.params as (string | number | null | Uint8Array)[]
      );
      setData(row?.count ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }

    return store.subscribeAll(() => {
      try {
        const ast = substituteRuntimeParams(request.query_ast as QueryAST, request.runtime_params ?? {});
        const compiled = compileToSqlite(ast, workspaceId);
        const row = queryOne<{ count: number }>(
          store.getDb(),
          `SELECT COUNT(*) AS count FROM (${compiled.sql})`,
          compiled.params as (string | number | null | Uint8Array)[]
        );
        setData(row?.count ?? 0);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    });
    // runtimeParamsKey is the stable JSON representation of request.runtime_params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, store, workspaceId, request.query_ast, runtimeParamsKey]);

  const isPending = storeLoading || isLoading;
  const resolvedError = error ?? storeError;
  const isErrorState = resolvedError !== null;
  const status: UseQueryResult<number, Error>['status'] = isPending
    ? 'pending'
    : isErrorState
      ? 'error'
      : 'success';

  return {
    data,
    isLoading: isPending,
    isError: isErrorState,
    error: resolvedError,
    isPending,
    isSuccess: !isPending && !isErrorState,
    status,
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<number, Error>;
}
