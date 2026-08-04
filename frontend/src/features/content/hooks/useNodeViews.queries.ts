/**
 * NodeView Query Hooks
 *
 * Reads view definitions from the local-first core SQLite store through the
 * async worker-backed client. Query execution itself is delegated to the
 * SQLite QueryAST adapters.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { NodeView, QueryExecuteRequest } from '@/types/nodeView';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import {
  useExecuteQueryAdapter,
  useQueryResultsAdapter,
} from '@/core/adapters/useQueryAstAdapter';
import type { QueryAST } from '@/types/queryAST';
export { nodeViewKeys } from '@/hooks/queryKeys';

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
  const { client, isLoading: storeLoading, error: storeError } = useWorkspaceStoreClient(
    enabled && workspaceId ? workspaceId : ''
  );
  const [data, setData] = useState<NodeView[]>([]);
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!client || !nodeUuid) {
      setData([]);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<NodeView[]>('getNodeViews', [nodeUuid, { viewType, includeQueryAST }])
        .then((views) => {
          if (!cancelled) setData(views);
        })
        .catch((err) => {
          console.error('[useNodeViews] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, nodeUuid, viewType, includeQueryAST, tick]);

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
  const { client, isLoading: storeLoading, error: storeError } = useWorkspaceStoreClient(
    enabled && workspaceId ? workspaceId : ''
  );
  const [data, setData] = useState<Record<string, NodeView[]>>({});

  useEffect(() => {
    if (!client || !nodeUuid) {
      setData({});
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<Record<string, NodeView[]>>('getNodeViewsByType', [nodeUuid])
        .then((grouped) => {
          if (!cancelled) setData(grouped);
        })
        .catch((err) => {
          console.error('[useNodeViewsByType] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, nodeUuid]);

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
  const { client, isLoading: storeLoading, error: storeError } = useWorkspaceStoreClient(
    enabled && workspaceId ? workspaceId : ''
  );
  const [data, setData] = useState<NodeView | undefined>(undefined);

  useEffect(() => {
    if (!client || !viewUuid) {
      setData(undefined);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<NodeView | undefined>('getNodeView', [viewUuid])
        .then((view) => {
          if (!cancelled) setData(view);
        })
        .catch((err) => {
          console.error('[useNodeView] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(viewUuid, update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, viewUuid]);

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
  const { client, isLoading: storeLoading, error: storeError } = useWorkspaceStoreClient(
    enabled && workspaceId ? workspaceId : ''
  );
  const [data, setData] = useState<NodeView | undefined>(undefined);

  useEffect(() => {
    if (!client || !nodeUuid || !viewType) {
      setData(undefined);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<NodeView | undefined>('getDefaultNodeView', [nodeUuid, viewType])
        .then((view) => {
          if (!cancelled) setData(view);
        })
        .catch((err) => {
          console.error('[useDefaultNodeView] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, nodeUuid, viewType]);

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
  const { client, isLoading: storeLoading, error: storeError } = useWorkspaceStoreClient(
    enabled && workspaceId ? workspaceId : ''
  );
  const [data, setData] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const hasDataRef = useRef(false);
  const runtimeParamsKey = JSON.stringify(request.runtime_params);

  useEffect(() => {
    if (!enabled || !client || !workspaceId || !request.query_ast) {
      setData(0);
      setIsLoading(false);
      setError(null);
      hasDataRef.current = false;
      return;
    }

    if (!hasDataRef.current) {
      setIsLoading(true);
    }
    setError(null);

    const run = async (): Promise<void> => {
      try {
        const count = await client.query<number>('countQueryResults', [workspaceId, request]);
        setData(count);
        hasDataRef.current = true;
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    };

    run();

    const onChange = (): void => {
      run().catch((err) => {
        setError(err instanceof Error ? err : new Error(String(err)));
      });
    };

    const unsubscribe = client.subscribe(null, onChange);
    return () => {
      unsubscribe();
      hasDataRef.current = false;
    };
    // runtimeParamsKey is the stable JSON representation of request.runtime_params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, client, workspaceId, request.query_ast, runtimeParamsKey]);

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
