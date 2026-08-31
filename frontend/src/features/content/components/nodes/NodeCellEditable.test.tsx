import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { NodeCellEditable } from './NodeCellEditable';
import type { Node } from '@/types';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ workspaceId: 'ws-1' }),
}));
vi.mock('@/core/hooks', () => ({
  useWorkspaceStoreClient: () => ({ client: null, isLoading: false, error: null }),
  useUndoManager: () => null,
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

// A node as projected by the local-first store: name is plain text produced
// by deriveName(), not AST JSON.
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

describe('NodeCellEditable', () => {
  it('renders the plain-text name of a projected node', () => {
    render(<NodeCellEditable node={projectedNode} />, { wrapper });
    expect(screen.getByText('Buy milk')).toBeInTheDocument();
  });
});
