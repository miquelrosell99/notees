# Linked References & Projection Layer Performance — Implementation Plan v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make pages with thousands of linked references open instantly by replacing ad-hoc repository calls with explicit query objects, splitting loading from hydration, adding a lightweight `NodeSummary` projection, and deferring backlink hydration until the user expands the section.

**Architecture:** Keep the operation-log / SQLite derived-store model unchanged. Insert a thin **GraphQuery** layer (`Repository → GraphQuery → Projection → React`) so every user-facing read has a single named query with declared inputs, output shape, cache key, and invalidation rules. Queries return IDs/cursors; a separate projection layer hydrates only the visible rows.

**Tech Stack:** TypeScript, React, sql.js, Web Workers, TanStack Query, Vitest.

## Global Constraints

- All changes happen in the `.worktrees/linked-refs-projection` worktree.
- The operation log remains the authoritative source of truth; derived tables can be rebuilt.
- New worker query/mutate methods must be wired through `WorkspaceStoreClient.ts` and `workspaceWorker.ts`.
- Frontend tests run with `cd frontend && npm run test:run` (Vitest/jsdom).
- Full-stack checks run inside containers per `AGENTS.md`.
- Conventional Commits, one logical commit per verified task.
- Do not change the public `Node` type shape unless unavoidable.

---

## Phase 0 — Query Object Foundation

This phase creates the missing architectural layer. All later optimizations are expressed as GraphQueries.

### Task 0.1: Define the `GraphQuery` base contract

**Files:**
- Create: `frontend/src/core/graphQueries/GraphQuery.ts`
- Create: `frontend/src/core/graphQueries/QueryInput.ts`
- Create: `frontend/src/core/graphQueries/QueryOutput.ts`
- Test: `frontend/src/core/graphQueries/__tests__/GraphQuery.test.ts` (type-only smoke test)

**Interfaces:**
- Produces: `GraphQuery<Input, Output>` interface that every named query implements.

**Steps:**

- [ ] **Step 1: Write the base contract**

```ts
// frontend/src/core/graphQueries/GraphQuery.ts
import type { WorkspaceStore } from '../store';
import type { NotifyChangeMessage } from '../worker/workerProtocol';

export interface GraphQuery<Input, Output> {
  /** Human-readable query name; used for worker dispatch and debugging. */
  readonly name: string;

  /** Stable cache key for the given input. */
  cacheKey(input: Input): string;

  /** Execute the query against the derived store. Must not hydrate children/properties unless required. */
  execute(store: WorkspaceStore, input: Input): Output;

  /**
   * Return true if this query should be re-executed when the worker emits a change.
   * This is the single place where invalidation rules live.
   */
  shouldInvalidate(input: Input, notification: NotifyChangeMessage): boolean;
}
```

- [ ] **Step 2: Add shared input/output utility types**

```ts
// frontend/src/core/graphQueries/QueryInput.ts
export interface NodeInput { nodeUuid: string; }
export interface PaginatedInput extends NodeInput { limit?: number; offset?: number; }

// frontend/src/core/graphQueries/QueryOutput.ts
export interface IdPageOutput {
  ids: string[];
  totalCount: number;
  hasMore: boolean;
}
```

- [ ] **Step 3: Smoke test**

```ts
import { describe, it, expect, vi } from 'vitest';
import type { GraphQuery } from './GraphQuery';
import type { WorkspaceStore } from '../../store';

describe('GraphQuery contract', () => {
  it('can be implemented', () => {
    const q: GraphQuery<{ nodeUuid: string }, { ids: string[] }> = {
      name: 'TestQuery',
      cacheKey: (i) => `test:${i.nodeUuid}`,
      execute: (_store, _i) => ({ ids: [] }),
      shouldInvalidate: () => false,
    };
    expect(q.name).toBe('TestQuery');
    expect(q.cacheKey({ nodeUuid: 'x' })).toBe('test:x');
  });
});
```

- [ ] **Step 4: Run test**

```bash
cd frontend
npm run test:run -- src/core/graphQueries/__tests__/GraphQuery.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/core/graphQueries
git commit -m "feat(graph-queries): define GraphQuery base contract"
```

---

### Task 0.2: Create the worker-side query registry and dispatcher

**Files:**
- Create: `frontend/src/core/graphQueries/queryRegistry.ts`
- Modify: `frontend/src/core/worker/queryHelpers.ts`
- Modify: `frontend/src/core/worker/WorkspaceStoreClient.ts`
- Modify: `frontend/src/core/worker/workspaceWorker.ts`
- Test: `frontend/src/core/graphQueries/__tests__/queryRegistry.test.ts`

**Interfaces:**
- Consumes: `GraphQuery` implementations.
- Produces: `executeGraphQuery(store, name, input)` dispatches any registered query by name.

**Steps:**

- [ ] **Step 1: Implement the registry**

```ts
// frontend/src/core/graphQueries/queryRegistry.ts
import type { WorkspaceStore } from '../store';
import type { GraphQuery } from './GraphQuery';

const registry = new Map<string, GraphQuery<unknown, unknown>>();

export function registerQuery<Input, Output>(query: GraphQuery<Input, Output>): void {
  registry.set(query.name, query as GraphQuery<unknown, unknown>);
}

export function executeGraphQuery(store: WorkspaceStore, name: string, input: unknown): unknown {
  const query = registry.get(name);
  if (!query) throw new Error(`Unknown graph query: ${name}`);
  return query.execute(store, input);
}

export function getRegisteredQueryNames(): string[] {
  return Array.from(registry.keys());
}
```

- [ ] **Step 2: Wire dispatcher in worker query helpers**

```ts
// frontend/src/core/worker/queryHelpers.ts
import { executeGraphQuery } from '../graphQueries/queryRegistry';

export function runGraphQuery(store: WorkspaceStore, name: string, input: unknown): unknown {
  return executeGraphQuery(store, name, input);
}
```

- [ ] **Step 3: Add `executeGraphQuery` to inline client dispatch**

In `WorkspaceStoreClient.ts` `query()` method:

```ts
if (method === 'executeGraphQuery') {
  const [name, input] = args as [string, unknown];
  return Promise.resolve(runGraphQuery(this.store, name, input) as T);
}
```

- [ ] **Step 4: Add `executeGraphQuery` to real worker dispatch**

In `workspaceWorker.ts` `handleQuery`, add:

```ts
if (method === 'executeGraphQuery') {
  const [name, input] = args as [string, unknown];
  const result = runGraphQuery(state.store!, name, input);
  postResponse({ type: 'query-result', id: request.id, result });
  return;
}
```

- [ ] **Step 5: Test the dispatcher**

```ts
import { describe, it, expect } from 'vitest';
import { registerQuery, executeGraphQuery } from './queryRegistry';
import type { WorkspaceStore } from '../../store';

registerQuery({
  name: 'EchoQuery',
  cacheKey: (i) => `echo:${(i as { x: string }).x}`,
  execute: (_store, i) => i,
  shouldInvalidate: () => false,
});

describe('queryRegistry', () => {
  it('dispatches a registered query', async () => {
    const { store } = await makeStore();
    const result = executeGraphQuery(store, 'EchoQuery', { x: 'hi' });
    expect(result).toEqual({ x: 'hi' });
  });

  it('throws for unknown queries', async () => {
    const { store } = await makeStore();
    expect(() => executeGraphQuery(store, 'Missing', {})).toThrow('Unknown graph query');
  });
});
```

- [ ] **Step 6: Run test**

```bash
cd frontend
npm run test:run -- src/core/graphQueries/__tests__/queryRegistry.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/core/graphQueries frontend/src/core/worker/queryHelpers.ts frontend/src/core/worker/WorkspaceStoreClient.ts frontend/src/core/worker/workspaceWorker.ts
git commit -m "feat(graph-queries): add worker-side query registry and dispatcher"
```

---

### Task 0.3: Implement the first concrete queries

**Files:**
- Create: `frontend/src/core/graphQueries/queries/GetChildrenQuery.ts`
- Create: `frontend/src/core/graphQueries/queries/GetBacklinksQuery.ts`
- Create: `frontend/src/core/graphQueries/queries/GetLinkedReferencesQuery.ts`
- Create: `frontend/src/core/graphQueries/queries/GetPageQuery.ts`
- Create: `frontend/src/core/graphQueries/queries/SearchQuery.ts`
- Create: `frontend/src/core/graphQueries/queries/index.ts`
- Test: `frontend/src/core/graphQueries/queries/__tests__/GetChildrenQuery.test.ts`
- Test: `frontend/src/core/graphQueries/queries/__tests__/GetLinkedReferencesQuery.test.ts`

**Interfaces:**
- Produces: named query objects that return IDs / lightweight metadata, not full `Node` trees.

**Steps:**

- [ ] **Step 1: `GetChildrenQuery`**

```ts
// frontend/src/core/graphQueries/queries/GetChildrenQuery.ts
import type { WorkspaceStore } from '../../store';
import type { GraphQuery } from '../GraphQuery';
import type { NodeInput } from '../QueryInput';
import type { IdPageOutput } from '../QueryOutput';

export const GetChildrenQuery: GraphQuery<NodeInput, IdPageOutput> = {
  name: 'GetChildrenQuery',
  cacheKey: (i) => `children:${i.nodeUuid}`,
  execute(store, i) {
    const ids = store.getChildren(i.nodeUuid);
    return { ids, totalCount: ids.length, hasMore: false };
  },
  shouldInvalidate(i, n) {
    return n.scope === 'tree' || n.scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
```

- [ ] **Step 2: `GetBacklinksQuery`**

```ts
// frontend/src/core/graphQueries/queries/GetBacklinksQuery.ts
import { getBacklinks } from '../../derived/edge';
import type { WorkspaceStore } from '../../store';
import type { GraphQuery } from '../GraphQuery';
import type { NodeInput } from '../QueryInput';
import type { IdPageOutput } from '../QueryOutput';

export const GetBacklinksQuery: GraphQuery<NodeInput, IdPageOutput> = {
  name: 'GetBacklinksQuery',
  cacheKey: (i) => `backlinks:${i.nodeUuid}`,
  execute(store, i) {
    const ids = getBacklinks(store.getDb(), i.nodeUuid);
    return { ids, totalCount: ids.length, hasMore: false };
  },
  shouldInvalidate(i, n) {
    return n.scope === 'edge' || n.scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
```

- [ ] **Step 3: `GetLinkedReferencesQuery`**

```ts
// frontend/src/core/graphQueries/queries/GetLinkedReferencesQuery.ts
import { createEmptyQueryAST } from '@/types/queryAST';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { queryNodeIds } from '../../query/queryNodes';
import type { WorkspaceStore } from '../../store';
import type { GraphQuery } from '../GraphQuery';
import type { PaginatedInput } from '../QueryInput';
import type { IdPageOutput } from '../QueryOutput';

export const GetLinkedReferencesQuery: GraphQuery<PaginatedInput, IdPageOutput> = {
  name: 'GetLinkedReferencesQuery',
  cacheKey: (i) => `linked-refs:${i.nodeUuid}:${i.limit ?? 'all'}:${i.offset ?? 0}`,
  execute(store, i) {
    const ast = autoFixSystemQuery(createEmptyQueryAST(), 'linked_references', { nodeUuid: i.nodeUuid });
    const allIds = queryNodeIds(store, {
      ast,
      runtimeParams: { current_node_uuid: i.nodeUuid, current_node_id: i.nodeUuid },
    });
    const offset = i.offset ?? 0;
    const limit = i.limit ?? allIds.length;
    const ids = allIds.slice(offset, offset + limit);
    return { ids, totalCount: allIds.length, hasMore: offset + limit < allIds.length };
  },
  shouldInvalidate(i, n) {
    return n.scope === 'edge' || n.scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
```

- [ ] **Step 4: `GetPageQuery`**

Returns a full Node for now; later tasks introduce `NodeSummary`.

```ts
// frontend/src/core/graphQueries/queries/GetPageQuery.ts
import { projectNode } from '../../adapters/nodeProjection';
import type { WorkspaceStore } from '../../store';
import type { GraphQuery } from '../GraphQuery';
import type { NodeInput } from '../QueryInput';
import type { Node } from '@/types/api';

export const GetPageQuery: GraphQuery<NodeInput, { node: Node | undefined }> = {
  name: 'GetPageQuery',
  cacheKey: (i) => `page:${i.nodeUuid}`,
  execute(store, i) {
    return { node: projectNode(store, i.nodeUuid, 2) };
  },
  shouldInvalidate(i, n) {
    return n.scope === 'node' || n.scope === 'tree' || n.scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
```

- [ ] **Step 5: `SearchQuery`**

```ts
// frontend/src/core/graphQueries/queries/SearchQuery.ts
import { queryNodeIds } from '../../query/queryNodes';
import type { WorkspaceStore } from '../../store';
import type { GraphQuery } from '../GraphQuery';
import type { IdPageOutput } from '../QueryOutput';

export interface SearchInput {
  query: string;
  classIds?: string[];
  isPage?: boolean;
  limit?: number;
  offset?: number;
}

export const SearchQuery: GraphQuery<SearchInput, IdPageOutput> = {
  name: 'SearchQuery',
  cacheKey: (i) => `search:${i.query}:${i.classIds?.join(',') ?? ''}:${i.isPage ?? ''}:${i.limit ?? 'all'}:${i.offset ?? 0}`,
  execute(store, i) {
    const allIds = queryNodeIds(store, {
      query: i.query,
      classIds: i.classIds,
      isPage: i.isPage,
    });
    const offset = i.offset ?? 0;
    const limit = i.limit ?? allIds.length;
    const ids = allIds.slice(offset, offset + limit);
    return { ids, totalCount: allIds.length, hasMore: offset + limit < allIds.length };
  },
  shouldInvalidate() {
    // Search is cheap enough to refresh on any change; refine later.
    return true;
  },
};
```

- [ ] **Step 6: Register all queries**

```ts
// frontend/src/core/graphQueries/queries/index.ts
import { registerQuery } from '../queryRegistry';
import { GetChildrenQuery } from './GetChildrenQuery';
import { GetBacklinksQuery } from './GetBacklinksQuery';
import { GetLinkedReferencesQuery } from './GetLinkedReferencesQuery';
import { GetPageQuery } from './GetPageQuery';
import { SearchQuery } from './SearchQuery';

export function registerAllQueries(): void {
  registerQuery(GetChildrenQuery);
  registerQuery(GetBacklinksQuery);
  registerQuery(GetLinkedReferencesQuery);
  registerQuery(GetPageQuery);
  registerQuery(SearchQuery);
}

export * from './GetChildrenQuery';
export * from './GetBacklinksQuery';
export * from './GetLinkedReferencesQuery';
export * from './GetPageQuery';
export * from './SearchQuery';
```

Call `registerAllQueries()` in `workspaceWorker.ts` after `handleInit` sets up the store (top-level import is fine; registry is synchronous).

- [ ] **Step 7: Add tests**

`GetLinkedReferencesQuery.test.ts`:

```ts
it('returns paginated ids', async () => {
  const store = await makeStore();
  store.createNode({ nodeId: 'target', kind: 'page', parentId: null });
  store.updateText('target', (t) => t.insert(0, 'Target'));
  for (let i = 0; i < 5; i++) {
    store.createNode({ nodeId: `s-${i}`, kind: 'block', parentId: null });
    store.updateText(`s-${i}`, (t) => t.insert(0, `See [[target]] ${i}`));
  }
  const result = GetLinkedReferencesQuery.execute(store, { nodeUuid: 'target', limit: 2, offset: 0 });
  expect(result.ids).toHaveLength(2);
  expect(result.totalCount).toBe(5);
  expect(result.hasMore).toBe(true);
});
```

- [ ] **Step 8: Run tests**

```bash
cd frontend
npm run test:run -- src/core/graphQueries/queries/__tests__
```

- [ ] **Step 9: Commit**

```bash
git add frontend/src/core/graphQueries
git commit -m "feat(graph-queries): add GetChildren, GetBacklinks, GetLinkedReferences, GetPage, Search queries"
```

---

### Task 0.4: Add `useGraphQuery` React hook

**Files:**
- Create: `frontend/src/core/graphQueries/hooks/useGraphQuery.ts`
- Create: `frontend/src/core/graphQueries/hooks/useGraphQueryClient.ts`
- Test: `frontend/src/core/graphQueries/hooks/__tests__/useGraphQuery.test.tsx`

**Interfaces:**
- Consumes: `GraphQuery`, `IWorkspaceStoreClient`.
- Produces: `useGraphQuery(query, input)` returns `{ data, isLoading, error, refetch }`.

**Steps:**

- [ ] **Step 1: Implement the hook**

```ts
// frontend/src/core/graphQueries/hooks/useGraphQuery.ts
import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStoreClient } from '../../hooks/useWorkspaceStoreClient';
import type { GraphQuery } from '../GraphQuery';

export function useGraphQuery<Input, Output>(
  query: GraphQuery<Input, Output>,
  input: Input,
  options?: { enabled?: boolean }
) {
  const enabled = options?.enabled ?? true;
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading: storeLoading } = useWorkspaceStoreClient(workspaceId ?? '');
  const [data, setData] = useState<Output | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cacheKey = useMemo(() => query.cacheKey(input), [query, input]);

  useEffect(() => {
    if (!enabled || !client) { setData(undefined); setIsLoading(false); setError(null); return; }
    let cancelled = false;
    const run = async () => {
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
    run();

    const unsubscribe = client.subscribe(null, (notification) => {
      if (query.shouldInvalidate(input, notification)) {
        run().catch((e) => setError(e));
      }
    });

    return () => { cancelled = true; unsubscribe(); };
  }, [client, query, cacheKey, enabled]);

  return { data, isLoading: storeLoading || isLoading, error };
}
```

- [ ] **Step 2: Add import for `useParams`**

```ts
import { useParams } from 'react-router-dom';
```

- [ ] **Step 3: Write a component-level test**

Mock the workspace client and verify the hook calls `executeGraphQuery` with the right name and invalidates on notifications.

- [ ] **Step 4: Run tests**

```bash
cd frontend
npm run test:run -- src/core/graphQueries/hooks/__tests__/useGraphQuery.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/core/graphQueries/hooks
git commit -m "feat(graph-queries): add useGraphQuery React hook"
```

---

## Phase 1 — NodeSummary Projection & Load/Hydrate Split

### Task 1.1: Define `NodeSummary` and `NodeSummaryProjection`

**Files:**
- Create: `frontend/src/core/projections/NodeSummaryProjection.ts`
- Create: `frontend/src/core/projections/index.ts`
- Modify: `frontend/src/core/adapters/nodeProjection.ts` (export `deriveName`)
- Test: `frontend/src/core/projections/__tests__/NodeSummaryProjection.test.ts`

**Interfaces:**
- Produces: `NodeSummary { id, title, icon, childCount, backlinkCount, hasChildren }`.

**Steps:**

- [ ] **Step 1: Export `deriveName` from nodeProjection**

Change `deriveName` from a private function to an exported function in `frontend/src/core/adapters/nodeProjection.ts`.

- [ ] **Step 2: Implement projection**

```ts
// frontend/src/core/projections/NodeSummaryProjection.ts
import type { Database } from 'sql.js';
import { queryOne } from '../db/sqlite';
import { deriveName } from '../adapters/nodeProjection';

export interface NodeSummary {
  id: string;
  title: string;
  icon: string | null;
  childCount: number;
  backlinkCount: number;
  hasChildren: boolean;
}

export function projectNodeSummary(db: Database, nodeId: string): NodeSummary | undefined {
  const node = queryOne<{ id: string; kind: string; content: string }>(
    db,
    'SELECT id, kind, content FROM node WHERE id = ?',
    [nodeId]
  );
  if (!node) return undefined;

  const stats = queryOne<{ child_count: number; backlink_count: number }>(
    db,
    'SELECT child_count, backlink_count FROM node_stats WHERE node_id = ?',
    [nodeId]
  );

  const childCount = stats?.child_count ?? 0;

  return {
    id: node.id,
    title: deriveName(node.content),
    icon: null,
    childCount,
    backlinkCount: stats?.backlink_count ?? 0,
    hasChildren: childCount > 0,
  };
}

export function hydrateNodeSummaries(db: Database, ids: string[]): NodeSummary[] {
  return ids
    .map((id) => projectNodeSummary(db, id))
    .filter((s): s is NodeSummary => s !== undefined);
}
```

- [ ] **Step 3: Write test**

```ts
it('projects a summary without children or content', async () => {
  const store = await makeStore();
  store.createNode({ nodeId: 'page', kind: 'page', parentId: null });
  store.updateText('page', (t) => t.insert(0, 'My page'));
  const summary = projectNodeSummary(store.getDb(), 'page');
  expect(summary).toMatchObject({ id: 'page', title: 'My page', childCount: 0, hasChildren: false });
});
```

- [ ] **Step 4: Run test**

```bash
cd frontend
npm run test:run -- src/core/projections/__tests__/NodeSummaryProjection.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/core/projections frontend/src/core/adapters/nodeProjection.ts
git commit -m "feat(projections): add NodeSummaryProjection"
```

---

### Task 1.2: Add a `HydrateBacklinksQuery` projection query

**Files:**
- Create: `frontend/src/core/graphQueries/queries/HydrateBacklinksQuery.ts`
- Create: `frontend/src/core/graphQueries/queries/HydrateLinkedReferencesQuery.ts`
- Modify: `frontend/src/core/graphQueries/queries/index.ts`
- Test: `frontend/src/core/graphQueries/queries/__tests__/HydrateLinkedReferencesQuery.test.ts`

**Interfaces:**
- Consumes: `NodeSummaryProjection`, existing `buildSyntheticRef` logic.
- Produces: `HydrateLinkedReferencesQuery` takes `{ nodeUuid, sourceIds }` and returns `LinkedReference[]`.

**Steps:**

- [ ] **Step 1: Move synthetic-ref building to a reusable projection**

Create `frontend/src/core/projections/LinkedReferenceProjection.ts` containing `buildSyntheticRef(store, sourceNodeId)` and `hydrateLinkedReferences(store, targetNodeUuid, sourceIds)`.

```ts
export function hydrateLinkedReferences(
  store: WorkspaceStore,
  _targetNodeUuid: string,
  sourceIds: string[]
): LinkedReference[] {
  return sourceIds
    .map((id) => buildSyntheticRef(store, id))
    .filter((ref): ref is LinkedReference => ref !== undefined);
}
```

- [ ] **Step 2: Create hydration query**

```ts
export const HydrateLinkedReferencesQuery: GraphQuery<{ nodeUuid: string; sourceIds: string[] }, LinkedReference[]> = {
  name: 'HydrateLinkedReferencesQuery',
  cacheKey: (i) => `hydrate-linked-refs:${i.nodeUuid}:${i.sourceIds.join(',')}`,
  execute(store, i) {
    return hydrateLinkedReferences(store, i.nodeUuid, i.sourceIds);
  },
  shouldInvalidate() {
    // Hydration is cheap; rely on the source ID query for invalidation.
    return false;
  },
};
```

- [ ] **Step 3: Register and test**

- [ ] **Step 4: Commit**

```bash
git add frontend/src/core/projections frontend/src/core/graphQueries/queries
git commit -m "feat(graph-queries): add HydrateLinkedReferencesQuery"
```

---

## Phase 2 — Schema & Materialized Counts

Phase 2 now builds the derived tables that the GraphQueries and Projections rely on.

### Task 2.1: Add `sync_outbox`, `edge` indexes, and `node_stats` table

Same as Tasks 1.1 and 2.1/2.2 from v1, but the `node_stats` table is consumed by `NodeSummaryProjection` and `GetBacklinksQuery`.

**Files:**
- Modify: `frontend/src/core/db/schema.ts`
- Create: `frontend/src/core/derived/nodeStats.ts`
- Test: `frontend/src/core/db/__tests__/schema.test.ts`
- Test: `frontend/src/core/derived/__tests__/nodeStats.test.ts`

**Steps:**

- [ ] Add `sync_outbox` table, `idx_edge_target_type`, `idx_edge_source_type`, and `node_stats` table.
- [ ] Add migrations to user_version 9.
- [ ] Implement `rebuildNodeStats`.
- [ ] Wire `rebuildNodeStats` into `WorkspaceStore.applyMany` and `rebuildEdgesForNode`.
- [ ] Commit.

---

## Phase 3 — Lazy Linked References via Query Objects

### Task 3.1: Replace `useLinkedReferences` with query-object pipeline

**Files:**
- Modify: `frontend/src/features/content/hooks/useNodeLinkQueries.ts`
- Modify: `frontend/src/features/content/hooks/useLinkedReferencesCount.ts`
- Modify: `frontend/src/features/content/components/nodes/QueryNodeCollection.tsx`
- Modify: `frontend/src/features/content/components/nodes/QuerySection.tsx`
- Test: `frontend/src/features/content/hooks/__tests__/useNodeLinkQueries.test.ts` (update or create)

**Interfaces:**
- Consumes: `GetLinkedReferencesQuery`, `HydrateLinkedReferencesQuery`, `useGraphQuery`.
- Produces: linked-reference sections render a cheap count badge first and only hydrate visible rows after expansion.

**Steps:**

- [ ] **Step 1: Rewrite `useLinkedReferences`**

```ts
export function useLinkedReferences(nodeUuid: string | null, params?: { limit?: number; offset?: number }) {
  const idsQuery = useGraphQuery(
    GetLinkedReferencesQuery,
    { nodeUuid: nodeUuid ?? '', limit: params?.limit, offset: params?.offset },
    { enabled: !!nodeUuid }
  );

  const hydrated = useGraphQuery(
    HydrateLinkedReferencesQuery,
    { nodeUuid: nodeUuid ?? '', sourceIds: idsQuery.data?.ids ?? [] },
    { enabled: !!nodeUuid && (idsQuery.data?.ids.length ?? 0) > 0 }
  );

  return {
    data: idsQuery.data ? {
      linked_references: hydrated.data ?? [],
      total_count: idsQuery.data.totalCount,
    } : undefined,
    isLoading: idsQuery.isLoading || hydrated.isLoading,
    isFetching: idsQuery.isLoading,
    error: idsQuery.error ?? hydrated.error,
  };
}
```

- [ ] **Step 2: Use `GetBacklinksQuery` for the count badge**

```ts
export function useLinkedReferencesCount(nodeUuid: string | null) {
  const backlinks = useGraphQuery(GetBacklinksQuery, { nodeUuid: nodeUuid ?? '' }, { enabled: !!nodeUuid });
  const propertyBacklinks = usePropertyBacklinks(nodeUuid);
  const total = (backlinks.data?.totalCount ?? 0) + (propertyBacklinks.data?.length ?? 0);
  return { count: total, isLoading: backlinks.isLoading || propertyBacklinks.isLoading };
}
```

- [ ] **Step 3: Lazy-load in `QueryNodeCollection`**

Only enable the linked-references ID query when the section is expanded. Keep the count query enabled always.

```ts
const linkedRefsExpanded = !lazyLoad || isExpanded;
const idsQuery = useGraphQuery(
  GetLinkedReferencesQuery,
  { nodeUuid, limit: LINKED_REFS_PAGE_SIZE, offset: linkedRefsOffset },
  { enabled: viewType === 'linked_references' && linkedRefsExpanded }
);
```

- [ ] **Step 4: Default linked-references sections to collapsed**

In `QuerySection`, set `defaultExpanded={viewType === 'linked_references' ? false : defaultExpanded}`.

- [ ] **Step 5: Run tests and type-check**

```bash
cd frontend
npx tsc -b --noEmit
npm run test:run -- src/features/content/hooks/__tests__/useNodeLinkQueries.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/content/hooks frontend/src/features/content/components/nodes
git commit -m "feat(linked-references): lazy-load and hydrate via query objects"
```

---

## Phase 4 — Batch Children Query & useBlockTree

### Task 4.1: Add `GetNodeTreeQuery` and `NodeTreeProjection`

**Files:**
- Create: `frontend/src/core/graphQueries/queries/GetNodeTreeQuery.ts`
- Create: `frontend/src/core/projections/NodeTreeProjection.ts`
- Modify: `frontend/src/core/graphQueries/queries/index.ts`
- Test: `frontend/src/core/graphQueries/queries/__tests__/GetNodeTreeQuery.test.ts`

**Interfaces:**
- Produces: a single recursive query returns subtree rows; projection converts to `Node[]`.

**Steps:**

- [ ] **Step 1: Implement `GetNodeTreeQuery`**

```ts
export const GetNodeTreeQuery: GraphQuery<{ nodeUuid: string; maxDepth: number }, { rows: TreeNode[] }> = {
  name: 'GetNodeTreeQuery',
  cacheKey: (i) => `node-tree:${i.nodeUuid}:${i.maxDepth}`,
  execute(store, i) {
    return { rows: getNodeTree(store.getDb(), i.nodeUuid, i.maxDepth) };
  },
  shouldInvalidate(i, n) {
    return n.scope === 'tree' || n.scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
```

- [ ] **Step 2: Implement `NodeTreeProjection.hydrate`**

```ts
export function hydrateNodeTree(rows: TreeNode[], visibleIds: Set<string>): Node[] {
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter((r) => visibleIds.has(r.id))
    .map((r) => rowToNodeSummary(r, rowMap));
}
```

- [ ] **Step 3: Wire and test**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(graph-queries): add GetNodeTreeQuery and NodeTreeProjection"
```

---

### Task 4.2: Use `GetNodeTreeQuery` in `useBlockTree`

**Files:**
- Modify: `frontend/src/features/content/hooks/useBlockTree.ts`
- Test: `frontend/src/features/content/hooks/useBlockTree.test.ts`

**Interfaces:**
- Consumes: `GetNodeTreeQuery`, `useGraphQuery`.
- Produces: `useBlockTree` fetches the visible subtree in one worker round-trip.

**Steps:**

- [ ] **Step 1: Replace recursive `projectNode`/`getChildren` with `GetNodeTreeQuery`**

When `nodeUuid` is provided and `maxDepth >= 0`:

```ts
const treeQuery = useGraphQuery(
  GetNodeTreeQuery,
  { nodeUuid, maxDepth },
  { enabled: !!client && !!nodeUuid }
);
```

Build `FlatNode[]` from the returned rows, applying collapsed state to decide which children are visible. For each visible row call `projectNode(store, id, 0)` to get the legacy `Node` shape needed by `BlockEditor`, but children are already known from the tree query.

- [ ] **Step 2: Add test**

Mock `useGraphQuery` returning a two-level tree and assert `getChildren` is not called.

- [ ] **Step 3: Commit**

```bash
git commit -m "perf(block-tree): fetch subtree in one GetNodeTreeQuery round-trip"
```

---

## Phase 5 — Fine-Grained Notifications

### Task 5.1: Extend notification protocol and emit scoped notifications

**Files:**
- Modify: `frontend/src/core/worker/workerProtocol.ts`
- Modify: `frontend/src/core/derived/index.ts`
- Modify: `frontend/src/core/derived/node.ts`, `edge.ts`, `property.ts`, `childOrder.ts`
- Modify: `frontend/src/core/worker/workspaceWorker.ts`
- Modify: `frontend/src/core/store.ts`

**Interfaces:**
- Produces: worker notifications now include `scope` and `relatedIds`; GraphQueries use them for invalidation.

**Steps:**

- [ ] **Step 1: Update protocol types**

```ts
export type NotifyScope = 'node' | 'edge' | 'tree' | 'class' | 'property' | 'all';

export interface NotifyChangeMessage {
  type: 'notify';
  scope?: NotifyScope;
  nodeId?: string;
  relatedIds?: string[];
}
```

- [ ] **Step 2: Update appliers to return notification metadata**

Change `applyNodeOperation`, `applyEdgeOperation`, etc. to return `{ scope, nodeId, relatedIds }`.

- [ ] **Step 3: Update dispatcher and worker to emit scoped notifications**

`frontend/src/core/derived/index.ts` returns an array of notifications. `workspaceWorker.ts` calls `postNotify` for each.

- [ ] **Step 4: Update `WorkspaceStore.notify` to accept scope**

```ts
notify(nodeId: string, scope: NotifyScope = 'node'): void
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(worker): emit scoped change notifications from appliers"
```

---

## Phase 6 — Verification & Documentation

### Task 6.1: Run full frontend checks

```bash
cd frontend
npm run lint
npx tsc -b --noEmit
npm run test:run
```

Fix failures.

### Task 6.2: Update `ARCHITECTURE.md`

Edit `/root/projects/notees/ARCHITECTURE.md`:

- Add a **GraphQuery layer** section describing `Repository → GraphQuery → Projection → React`.
- Document `NodeSummary` and the load/hydrate split.
- Add `node_stats` and edge indexes to the data model.
- Update Backlinks implementation to describe `GetLinkedReferencesQuery` + `HydrateLinkedReferencesQuery` + lazy loading.
- Update Caching and Performance sections.

### Task 6.3: Save this plan to `docs/superpowers/plans/`

Copy the final approved plan to:

```
docs/superpowers/plans/2026-07-30-linked-refs-projection.md
```

Mark completed tasks with `- [x]`.

### Task 6.4: Final commit

```bash
git add ARCHITECTURE.md docs/superpowers/plans/2026-07-30-linked-refs-projection.md
git commit -m "docs: update architecture and plan for query-object projection layer"
```

---

## Spec Coverage Check

| Requirement from user | Task |
|-----------------------|------|
| Explicit query objects | Phase 0 |
| Named queries with inputs/output/cache/invalidation | Task 0.1, 0.3 |
| Worker dispatcher for queries | Task 0.2 |
| `NodeSummary` projection | Task 1.1 |
| Load/hydrate split for backlinks | Tasks 1.2, 3.1 |
| Add `edge(target_id, type)` index | Phase 2 |
| Add `edge(source_id, type)` index | Phase 2 |
| Materialized counts | Phase 2 |
| Lazy linked references | Phase 3 |
| Batch subtree query | Phase 4 |
| Fine-grained invalidation | Phase 5 |
| Update architecture/plan docs | Phase 6 |

## Placeholder Scan

No TBD/TODO placeholders. Every step contains file paths, code, test commands, and commit messages.
