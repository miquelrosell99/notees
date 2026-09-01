/**
 * Collapsed query sections must run only a COUNT query (countQueryResults);
 * the full node query (queryNodes) runs once the section is expanded.
 * linked_references keeps its own dedicated lazy path.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { webcrypto } from 'node:crypto';
import { WorkspaceStoreProvider } from '@/core/hooks/WorkspaceStoreProvider';
import { MemoryRelay, MemoryTransport } from '@/core/transport';
import { getOrCreateWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { getOrCreateWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import { uuidv7 } from '@/core/uuid';
import { createEmptyQueryAST, createClassCondition } from '@/types/queryAST';
import type { QueryAST } from '@/types/queryAST';
import { QuerySection } from './QuerySection';
import { QueryNodeCollection } from './QueryNodeCollection';

// Keep the render surface small: the real NodeCollection and modals are not
// under test here. The stub still renders leftElement (the section header)
// and hides nodes while collapsed, mirroring the real component contract.
vi.mock('@/features/content/components/nodes/NodeCollection', () => ({
  NodeCollection: (props: {
    nodes?: Array<{ uuid: string; name: string }>;
    leftElement?: ReactNode;
    hideContent?: boolean;
  }) => (
    <div data-testid="node-collection">
      {props.leftElement}
      {!props.hideContent &&
        (props.nodes ?? []).map((n) => (
          <div key={n.uuid} data-testid="result-node">{n.name || n.uuid}</div>
        ))}
    </div>
  ),
}));

vi.mock('@/features/content/components/nodes/QueryNodeCollection/QueryEditModal', () => ({
  QueryEditModal: () => null,
}));

vi.mock('@/features/content/components/nodes/QueryNodeCollection/QueryPreviewModal', () => ({
  QueryPreviewModal: () => null,
}));

function createProviderProps() {
  const actorId = uuidv7();
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, 'ws-test');
  return { actorId, transport };
}

function wrapper(props: { actorId: string; transport: MemoryTransport }) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/ws-test']}>
          <Routes>
            <Route
              path="/:workspaceId/*"
              element={
                <WorkspaceStoreProvider
                  actorId={props.actorId}
                  transport={props.transport}
                >
                  {children}
                </WorkspaceStoreProvider>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function makeClassQueryAST(classId: string): QueryAST {
  return {
    ...createEmptyQueryAST(),
    scope: { type: 'scope' as const, scope_type: 'pages' as const },
    root_group: {
      type: 'group' as const,
      logic: 'AND' as const,
      children: [createClassCondition(classId)],
    },
  };
}

type QuerySpy = { mock: { calls: unknown[][] } };

function callsTo(spy: QuerySpy, method: string) {
  return spy.mock.calls.filter((args) => args[0] === method);
}

describe('QuerySection collapsed count', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('runs only countQueryResults while collapsed, queryNodes once expanded', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);
    const classId = uuidv7();
    const nodeUuid = uuidv7();

    const store = await getOrCreateWorkspaceStore('ws-test', props.actorId, props.transport);
    store.createClass({ classId, name: 'Match class' });
    store.createNode({ nodeId: uuidv7(), kind: 'page', parentId: null, classIds: [classId] });
    store.createNode({ nodeId: uuidv7(), kind: 'page', parentId: null, classIds: [classId] });
    store.createNode({ nodeId: uuidv7(), kind: 'page', parentId: null });

    const client = await getOrCreateWorkspaceStoreClient('ws-test', props.actorId, props.transport);
    const querySpy = vi.spyOn(client, 'query');

    const ast = makeClassQueryAST(classId);
    render(
      <QuerySection
        nodeUuid={nodeUuid}
        viewType="inline_query"
        title="Matching pages"
        defaultExpanded={false}
        queryAST={ast}
        onQueryASTChange={() => undefined}
      />,
      { wrapper: Wrapper },
    );

    // Header badge resolves from the COUNT query while collapsed.
    await screen.findByText('(2)');
    expect(callsTo(querySpy, 'countQueryResults').length).toBeGreaterThan(0);
    expect(callsTo(querySpy, 'queryNodes')).toHaveLength(0);
    // The COUNT runs against the same execution AST.
    const countArgs = callsTo(querySpy, 'countQueryResults')[0][1] as [
      string,
      { query_ast?: QueryAST },
    ];
    expect(countArgs[1].query_ast).toEqual(ast);
    // Content stays hidden while collapsed.
    expect(screen.queryAllByTestId('result-node')).toHaveLength(0);

    // Expanding flips to the full node query.
    fireEvent.click(screen.getByRole('button', { name: 'Expand section' }));
    await waitFor(() =>
      expect(callsTo(querySpy, 'queryNodes').length).toBeGreaterThan(0)
    );
    const nodeArgs = callsTo(querySpy, 'queryNodes')[0][1] as [
      { ast?: QueryAST },
    ];
    expect(nodeArgs[0].ast).toEqual(ast);
    await waitFor(() =>
      expect(screen.getAllByTestId('result-node')).toHaveLength(2)
    );
    // Header count now comes from the expanded result set.
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('reports the count via onCountChange while collapsed', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);
    const classId = uuidv7();
    const nodeUuid = uuidv7();

    const store = await getOrCreateWorkspaceStore('ws-test', props.actorId, props.transport);
    store.createClass({ classId, name: 'Count class' });
    store.createNode({ nodeId: uuidv7(), kind: 'page', parentId: null, classIds: [classId] });
    store.createNode({ nodeId: uuidv7(), kind: 'page', parentId: null, classIds: [classId] });
    store.createNode({ nodeId: uuidv7(), kind: 'page', parentId: null, classIds: [classId] });

    const client = await getOrCreateWorkspaceStoreClient('ws-test', props.actorId, props.transport);
    const querySpy = vi.spyOn(client, 'query');

    const onCountChange = vi.fn();
    render(
      <QueryNodeCollection
        nodeUuid={nodeUuid}
        viewType="inline_query"
        hideContent
        queryAST={makeClassQueryAST(classId)}
        onCountChange={onCountChange}
      >
        {({ results }) => <div data-testid="results">{results}</div>}
      </QueryNodeCollection>,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(3));
    expect(callsTo(querySpy, 'countQueryResults').length).toBeGreaterThan(0);
    expect(callsTo(querySpy, 'queryNodes')).toHaveLength(0);
  });

  it('linked_references keeps its dedicated count path (no countQueryResults/queryNodes)', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);
    const targetUuid = uuidv7();
    const sourceUuid = uuidv7();

    const store = await getOrCreateWorkspaceStore('ws-test', props.actorId, props.transport);
    store.createNode({ nodeId: targetUuid, kind: 'page', parentId: null });
    store.updateText(targetUuid, (t) => t.insert(0, 'Linked target'));
    store.createNode({ nodeId: sourceUuid, kind: 'page', parentId: null });
    store.updateText(sourceUuid, (t) => t.insert(0, `See [[${targetUuid}]]`));

    const client = await getOrCreateWorkspaceStoreClient('ws-test', props.actorId, props.transport);
    const querySpy = vi.spyOn(client, 'query');

    render(
      <QuerySection
        nodeUuid={targetUuid}
        viewType="linked_references"
        title="Linked references"
        hideWhenEmpty={false}
      />,
      { wrapper: Wrapper },
    );

    // Collapsed (default for linked_references): dedicated backlink count runs,
    // never the generic AST paths.
    await waitFor(() =>
      expect(
        callsTo(querySpy, 'executeGraphQuery').some(
          ([, args]) => (args as [string])[0] === 'GetBacklinksQuery',
        ),
      ).toBe(true)
    );
    expect(callsTo(querySpy, 'countQueryResults')).toHaveLength(0);
    expect(callsTo(querySpy, 'queryNodes')).toHaveLength(0);
    expect(
      callsTo(querySpy, 'executeGraphQuery').some(
        ([, args]) => (args as [string])[0] === 'GetLinkedReferencesQuery',
      ),
    ).toBe(false);

    // Expanding loads the full linked-references data via the dedicated query.
    fireEvent.click(screen.getByRole('button', { name: 'Expand section' }));
    await waitFor(() =>
      expect(
        callsTo(querySpy, 'executeGraphQuery').some(
          ([, args]) => (args as [string])[0] === 'GetLinkedReferencesQuery',
        ),
      ).toBe(true)
    );
    expect(callsTo(querySpy, 'queryNodes')).toHaveLength(0);
  });
});
