import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { TableView } from './TableView';
import type { Node } from '@/types';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ workspaceId: 'ws-1' }),
}));
vi.mock('@/core/hooks/useWorkspaceStoreClient', () => ({
  useWorkspaceStoreClient: () => ({ client: null, isLoading: false, error: null }),
}));
vi.mock('@/core/hooks', () => ({
  useWorkspaceStoreClient: () => ({ client: null, isLoading: false, error: null }),
  useUndoManager: () => null,
  useClasses: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/core/adapters/workspaceStoreClientAdapter', () => ({
  getWorkspaceStoreClient: () => null,
}));
vi.mock('@/features/properties', () => ({
  useProperties: () => ({ data: [] }),
  getPropertyValueRenderer: () => () => null,
  PropertyCell: () => null,
}));
vi.mock('@/features/content', async (importActual) => {
  const actual = await importActual<typeof import('@/features/content')>();
  return {
    ...actual,
    useClasses: () => ({ data: [] }),
    useAddClass: () => ({ mutate: vi.fn() }),
    useRemoveClass: () => ({ mutate: vi.fn() }),
    getOrCreateDailyNoteClient: vi.fn(),
    NodeSelector: () => null,
    NodeRef: () => null,
    CollapsiblePillRow: () => null,
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

// A node as projected by the local-first store: plain-text name, no numeric id.
const projectedNode = {
  uuid: 'node-uuid-1',
  name: 'Buy milk',
  content: '',
  icon: null,
  color: null,
  parent_uuid: null,
  page_uuid: null,
  sequence: 0,
  active: true,
  is_page: false,
  create_date: '2026-08-31T00:00:00Z',
  write_date: '2026-08-31T00:00:00Z',
} as unknown as Node;

describe('TableView name column', () => {
  it('renders the node name in the editable name cell', () => {
    render(<TableView nodes={[projectedNode]} editable={true} selectable={false} />, { wrapper });
    expect(screen.getByText('Buy milk')).toBeInTheDocument();
  });

  it('renders the node name in the read-only name cell', () => {
    render(<TableView nodes={[projectedNode]} editable={false} selectable={false} />, { wrapper });
    expect(screen.getByText('Buy milk')).toBeInTheDocument();
  });
});
