import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClassPillsRow } from './ClassPillsRow';
import { useAuthStore } from '@/stores';
import type { Node } from '@/types';
import type { ClassRow } from '@/core/query/classes';

const { classListRef } = vi.hoisted(() => ({ classListRef: { current: [] as ClassRow[] } }));

vi.mock('@/core/hooks', () => ({
  useWorkspaceStore: vi.fn(() => ({ store: null, isLoading: false, error: null })),
  useWorkspaceStoreClient: vi.fn(() => ({ client: null, isLoading: false, error: null })),
  useNode: vi.fn(() => ({ node: undefined, isLoading: false })),
  useChildren: vi.fn(() => ({ children: [], isLoading: false })),
  useUndoManager: vi.fn(() => ({ group: vi.fn(), wrap: vi.fn() })),
  useClasses: vi.fn(() => ({ data: classListRef.current, isLoading: false, error: null })),
}));

function makeClassRow(overrides: Partial<ClassRow> = {}): ClassRow {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    workspaceId: 'ws-test',
    name: 'Test Class',
    icon: null,
    color: null,
    description: null,
    extendsClassIds: [],
    active: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    uuid: '00000000-0000-0000-0000-000000000000',
    name: 'Test Node',
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: true,
    create_date: '2024-01-01T00:00:00Z',
    write_date: '2024-01-01T00:00:00Z',
    ...overrides,
  } as Node;
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('ClassPillsRow inherited color', () => {
  beforeEach(() => {
    useAuthStore.setState({ authVerified: true });
  });

  it('renders a class pill with the color inherited from its parent class', () => {
    const agent = makeClassRow({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Agent',
      color: '#ff8800',
    });
    const person = makeClassRow({
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Person',
      color: null,
      extendsClassIds: [agent.id],
    });

    classListRef.current = [agent, person];
    const personNode = makeNode({
      uuid: person.id,
      name: person.name,
      color: person.color,
      is_class: true,
      extends_uuid: person.extendsClassIds,
    });
    render(
      <TestWrapper>
        <ClassPillsRow classes={[personNode]} nodeUuid="page-uuid" readOnly />
      </TestWrapper>
    );

    const pill = screen.getByText('Person').closest('.pill');
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });
});
