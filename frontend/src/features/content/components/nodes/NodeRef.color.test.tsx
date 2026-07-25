import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NodeRef } from './NodeRef';
import { useAuthStore } from '@/stores';
import type { Node } from '@/types';
import type { ClassRow } from '@/core/query/classes';

const { classListRef } = vi.hoisted(() => ({ classListRef: { current: [] as ClassRow[] } }));

vi.mock('@/core/hooks', () => ({
  useWorkspaceStore: vi.fn(() => ({ store: null, isLoading: false, error: null })),
  useNode: vi.fn(() => ({ node: undefined, isLoading: false })),
  useChildren: vi.fn(() => ({ children: [], isLoading: false })),
  useUndoManager: vi.fn(() => ({ group: vi.fn(), wrap: vi.fn() })),
  useClasses: vi.fn(() => ({ data: classListRef.current, isLoading: false, error: null })),
}));

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

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('NodeRef class pill color', () => {
  beforeEach(() => {
    useAuthStore.setState({ authVerified: true });
  });

  it('shows inherited color for a class pill whose class extends a colored class', () => {
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
    const personNode = makeNode({
      uuid: person.id,
      name: person.name,
      color: person.color,
      is_class: true,
      extends_uuid: person.extendsClassIds,
    });

    classListRef.current = [agent, person];
    render(
      <TestWrapper>
        <NodeRef node={personNode} readOnly />
      </TestWrapper>
    );

    const pill = screen.getByText('Person').closest('.pill');
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });

  it('shows own color for a class pill with an explicit color', () => {
    const agent = makeClassRow({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Agent',
      color: '#ff8800',
    });
    const agentNode = makeNode({
      uuid: agent.id,
      name: agent.name,
      color: agent.color,
      is_class: true,
    });

    classListRef.current = [agent];
    render(
      <TestWrapper>
        <NodeRef node={agentNode} readOnly />
      </TestWrapper>
    );

    const pill = screen.getByText('Agent').closest('.pill');
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });

  it('shows inherited color when the rendered node lacks extends_uuid but allClasses has it', () => {
    const agent = makeClassRow({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Agent',
      color: '#ff8800',
    });
    const personFromGenericResponse = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Person',
      color: null,
      is_class: true,
    });
    const canonicalPerson = makeClassRow({
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Person',
      color: null,
      extendsClassIds: [agent.id],
    });

    classListRef.current = [agent, canonicalPerson];
    render(
      <TestWrapper>
        <NodeRef node={personFromGenericResponse} readOnly />
      </TestWrapper>
    );

    const pill = screen.getByText('Person').closest('.pill');
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });

  it('re-renders with the newly inherited color when the resolved class object changes', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const agent = makeClassRow({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Agent',
      color: null,
    });
    const person = makeClassRow({
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Person',
      color: null,
      extendsClassIds: [agent.id],
    });
    const personNode = makeNode({
      uuid: person.id,
      name: person.name,
      color: person.color,
      is_class: true,
      extends_uuid: person.extendsClassIds,
    });

    classListRef.current = [agent, person];

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <NodeRef node={personNode} readOnly />
      </QueryClientProvider>
    );

    expect((screen.getByText('Person').closest('.pill') as HTMLElement).style.backgroundColor).toBe('');

    // Simulate the classes list being re-resolved with a colored parent.
    // The resolved class node for "person" becomes a new object even though
    // its field values are identical.
    const agentWithColor = makeClassRow({
      id: agent.id,
      name: agent.name,
      color: '#ff8800',
    });
    const freshPerson = makeClassRow({
      id: person.id,
      name: person.name,
      color: null,
      extendsClassIds: [agentWithColor.id],
    });
    const freshPersonNode = makeNode({
      uuid: freshPerson.id,
      name: freshPerson.name,
      color: freshPerson.color,
      is_class: true,
      extends_uuid: freshPerson.extendsClassIds,
    });

    classListRef.current = [agentWithColor, freshPerson];

    rerender(
      <QueryClientProvider client={queryClient}>
        <NodeRef node={freshPersonNode} readOnly />
      </QueryClientProvider>
    );

    expect((screen.getByText('Person').closest('.pill') as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });
});
