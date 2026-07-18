import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { webcrypto } from 'node:crypto';
import { NodeCollectionView } from './NodeCollectionView';
import { createEmptyQueryAST, createClassCondition } from '@/types/queryAST';
import { WorkspaceStore } from '@/core/store';
import { createTestDatabase } from '@/core/__tests__/helpers';
import { uuidv7 } from '@/core/uuid';

const openNodeMock = vi.fn();
const closeNodeCollectionMock = vi.fn();
const addSidebarCardMock = vi.fn();
const saveAsViewMock = vi.fn().mockResolvedValue(undefined);

let queryCollectionProps: Record<string, unknown> = {};
let testStore: WorkspaceStore | undefined;

vi.mock('@/features/content/components/nodes/QueryNodeCollection', () => ({
  QueryNodeCollection: (props: Record<string, unknown>) => {
    queryCollectionProps = props;
    return (
      <div data-testid="query-node-collection">
        <button type="button" onClick={() => (props.onCountChange as (n: number) => void)?.(5)}>set count</button>
        {(props.children as (args: { results: ReactNode }) => ReactNode)({ results: <div>query results</div> })}
      </div>
    );
  },
}));

vi.mock('@/features/content/components/nodes/NodeCollection', () => ({
  NodeCollection: (props: Record<string, unknown>) => (
    <div data-testid="node-collection">
      {(props.nodes as { uuid: string; name: string }[]).map((n) => <div key={n.uuid}>{n.name}</div>)}
    </div>
  ),
}));

vi.mock('@/features/content', () => ({
  useClasses: () => ({ data: [] }),
}));

vi.mock('@/features/layout', () => ({
  useCollectionNavigation: () => ({
    openNode: openNodeMock,
    closeNodeCollection: closeNodeCollectionMock,
    addSidebarCard: addSidebarCardMock,
  }),
}));

vi.mock('@/features/queries', () => ({
  useSaveQueryAsView: () => ({ saveAsView: saveAsViewMock, isSaving: false }),
}));

vi.mock('@/hooks/useCurrentWorkspaceUuid', () => ({
  useCurrentWorkspaceUuid: vi.fn(() => 'ws-test'),
}));

vi.mock('@/core/hooks/useWorkspaceStore', () => ({
  useWorkspaceStore: vi.fn(() => ({ store: testStore, isLoading: false, error: null })),
}));

async function createTestStore(): Promise<WorkspaceStore> {
  const db = await createTestDatabase();
  return new WorkspaceStore(db, uuidv7(), uuidv7());
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const ast = {
  ...createEmptyQueryAST(),
  root_group: {
    type: 'group' as const,
    logic: 'AND' as const,
    children: [createClassCondition('cls-uuid-1')],
  },
};

describe('NodeCollectionView', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    queryCollectionProps = {};
    testStore = await createTestStore();

    testStore.createNode({ nodeId: 'a', kind: 'page', parentId: null });
    testStore.createNode({ nodeId: 'b', kind: 'page', parentId: null });
    testStore.updateText('a', (text) => {
      text.delete(0, text.toPlaintext().length);
      text.insert(0, 'Node a');
    });
    testStore.updateText('b', (text) => {
      text.delete(0, text.toPlaintext().length);
      text.insert(0, 'Node b');
    });
  });

  it('AST mode renders title, Temporary chip, intent prose and a save action', () => {
    render(<NodeCollectionView title="Unscheduled tasks" queryAST={ast} />, { wrapper });
    expect(screen.getByText('Unscheduled tasks')).toBeInTheDocument();
    expect(screen.getByText('Temporary')).toBeInTheDocument();
    expect(screen.getByText(/in all pages/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save as view/i })).toBeInTheDocument();
    expect(screen.getByTestId('query-node-collection')).toBeInTheDocument();
    expect(queryCollectionProps.queryAST).toBe(ast);
  });

  it('shows the running total from the query collection', () => {
    render(<NodeCollectionView title="Unscheduled tasks" queryAST={ast} />, { wrapper });
    fireEvent.click(screen.getByText('set count'));
    expect(screen.getByText('(5)')).toBeInTheDocument();
  });

  it('save flow prompts for a name (prefilled with the title) and promotes the AST', async () => {
    render(<NodeCollectionView title="Unscheduled tasks" queryAST={ast} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /save as view/i }));
    const input = screen.getByLabelText('View name');
    expect((input as HTMLInputElement).value).toBe('Unscheduled tasks');
    fireEvent.change(input, { target: { value: 'Someday list' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveAsViewMock).toHaveBeenCalledWith('Someday list', ast));
  });

  it('nodeUuids mode resolves nodes, renders the collection, and hides the save action', async () => {
    render(<NodeCollectionView title="Search results" nodeUuids={['a', 'b']} />, { wrapper });
    await waitFor(() => expect(screen.getByText('Node a')).toBeInTheDocument());
    expect(screen.getByText('Node b')).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save as view/i })).not.toBeInTheDocument();
  });

  it('close button calls closeNodeCollection', () => {
    render(<NodeCollectionView title="Unscheduled tasks" queryAST={ast} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closeNodeCollectionMock).toHaveBeenCalled();
  });
});
