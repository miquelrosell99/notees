import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGraphQueryClient } from './useGraphQueryClient';
import type { GraphQuery } from '../GraphQuery';
import type { NotifyChangeMessage } from '../../worker/workerProtocol';

export function useGraphQuery<Input, Output>(
  query: GraphQuery<Input, Output>,
  input: Input,
  options?: { enabled?: boolean }
) {
  const enabled = options?.enabled ?? true;
  const { client, isLoading: storeLoading } = useGraphQueryClient();
  const [data, setData] = useState<Output | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cacheKey = useMemo(() => query.cacheKey(input), [query, input]);

  const run = useCallback(async () => {
    if (!client) return;
    setIsLoading(true);
    try {
      const result = await client.query<Output>('executeGraphQuery', [query.name, input]);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [client, query, input]);

  useEffect(() => {
    if (!enabled || !client) {
      setData(undefined);
      setIsLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const runSafe = async () => {
      setIsLoading(true);
      try {
        const result = await client.query<Output>('executeGraphQuery', [query.name, input]);
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    runSafe();

    const unsubscribe = client.subscribe(null, (notification?: NotifyChangeMessage) => {
      if (query.shouldInvalidate(input, notification ?? { type: 'notify' })) {
        runSafe().catch((e) => setError(e));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // cacheKey is derived from input via query.cacheKey, so input identity is
    // already captured; including it here would re-run the effect on every new
    // object reference even when the cache key is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, query, cacheKey, enabled]);

  const refetch = useCallback(() => run(), [run]);

  return { data, isLoading: storeLoading || isLoading, error, refetch };
}
