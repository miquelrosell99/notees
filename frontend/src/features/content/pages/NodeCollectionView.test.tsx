import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { NodeCollectionView } from './NodeCollectionView';
import { createEmptyQueryAST, createClassCondition } from '@/types/queryAST';

const openNodeMock = vi.fn();
const closeNodeCollectionMock = vi.fn();
const addSidebarCardMock = vi.fn();
const saveAsViewMock = vi.fn().mockResolvedValue(undefined);
const getNodeMock = vi.fn();

let queryCollectionProps: Record<string, unknown> = {};

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

vi.mock('@/api/nodes', () => ({
  getNode: (...args: unknown[]) => getNodeMock(...args),
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
    queryCollectionProps = {};
    getNodeMock.mockImplementation(async (uuid: string) => ({ uuid, name: `Node ${uuid}`, is_page: false }));
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
    expect(getNodeMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /save as view/i })).not.toBeInTheDocument();
  });

  it('close button calls closeNodeCollection', () => {
    render(<NodeCollectionView title="Unscheduled tasks" queryAST={ast} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closeNodeCollectionMock).toHaveBeenCalled();
  });
});
