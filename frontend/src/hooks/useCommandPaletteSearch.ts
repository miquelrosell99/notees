/**
 * useCommandPaletteSearch
 *
 * Manages a persistent Web Worker that categorizes search results
 * off the main thread so the command palette input stays snappy.
 *
 * Features:
 * - Singleton worker per hook instance (created once, reused)
 * - Sequence IDs: stale responses are silently discarded
 * - useTransition: result state updates are low-priority — input is never blocked
 */

import { useEffect, useRef, useTransition, useState, useCallback } from 'react';
import type { Node, Property } from '@/types';
import type {
  WorkerRequest,
  WorkerResponse,
} from '@/workers/commandPaletteWorker';

export interface CategorizedResults {
  pages: Array<{ node: Node; breadcrumb?: string }>;
  blocks: Array<{ node: Node; breadcrumb: string }>;
  properties: Property[];
}

const EMPTY: CategorizedResults = { pages: [], blocks: [], properties: [] };

export function useCommandPaletteSearch(
  searchResults: Node[] | undefined,
  allProperties: Property[],
  searchTerm: string,
): { results: CategorizedResults; isPending: boolean } {
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0);
  const [results, setResults] = useState<CategorizedResults>(EMPTY);
  const [isPending, startTransition] = useTransition();

  // Fresh node/property maps so the onmessage closure always reads current data
  const nodeMapRef = useRef<Map<number, Node>>(new Map());
  const propMapRef = useRef<Map<number, Property>>(new Map());

  // Boot worker once
  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/commandPaletteWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const { id, pages: rawPages, blocks: rawBlocks, properties: rawProps } = e.data;

      // Discard stale responses
      if (id !== seqRef.current) return;

      // We need the original Node objects — use the closure over the latest
      // searchResults. Because this callback closes over nothing mutable,
      // we store the node map in a ref updated before posting.
      const nodeMap = nodeMapRef.current;
      const propMap = propMapRef.current;

      const pages = rawPages.flatMap(r => {
        const node = nodeMap.get(r.nodeId);
        return node ? [{ node }] : [];
      });

      const blocks = rawBlocks.flatMap(r => {
        const node = nodeMap.get(r.nodeId);
        return node ? [{ node, breadcrumb: r.breadcrumb }] : [];
      });

      const properties = rawProps.flatMap(r => {
        const prop = propMap.get(r.propertyId);
        return prop ? [prop] : [];
      });

      // Low-priority update — keeps input responsive
      startTransition(() => {
        setResults({ pages, blocks, properties });
      });
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep fresh node/property maps the worker response can look up
  useEffect(() => {
    const map = new Map<number, Node>();
    for (const n of searchResults ?? []) map.set(n.id, n);
    nodeMapRef.current = map;
  }, [searchResults]);

  useEffect(() => {
    const map = new Map<number, Property>();
    for (const p of allProperties) map.set(p.id, p);
    propMapRef.current = map;
  }, [allProperties]);

  // Post to worker whenever inputs change
  const postToWorker = useCallback(() => {
    if (!workerRef.current || !searchResults) {
      setResults(EMPTY);
      return;
    }

    const id = ++seqRef.current;

    // Send slim node representation — worker only needs id, name, parent_id, page_id
    const nodes = searchResults.map(n => ({
      id: n.id,
      name: n.name,
      parent_id: n.parent_id,
      page_id: n.page_id,
    }));

    const properties = allProperties.map(p => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
    }));

    const request: WorkerRequest = { id, nodes, properties, searchTerm };
    workerRef.current.postMessage(request);
  }, [searchResults, allProperties, searchTerm]);

  useEffect(() => {
    postToWorker();
  }, [postToWorker]);

  // Reset when there's nothing to search
  useEffect(() => {
    if (!searchTerm.trim() || !searchResults?.length) {
      startTransition(() => setResults(EMPTY));
    }
  }, [searchTerm, searchResults]);

  return { results, isPending };
}
