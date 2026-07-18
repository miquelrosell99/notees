import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NodeRef } from './NodeRef';
import { useAuthStore } from '@/stores';
import type { Node } from '@/types';

const { classListRef } = vi.hoisted(() => ({ classListRef: { current: [] as Node[] } }));

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

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('NodeRef class pill color', () => {
  beforeEach(() => {
    useAuthStore.setState({ authVerified: true });
  });

  it('shows inherited color for a class pill whose class extends a colored class', () => {
    const agent = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Agent',
      color: '#ff8800',
      is_class: true,
    });
    const person = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Person',
      color: null,
      is_class: true,
      extends_uuid: [agent.uuid],
    });

    classListRef.current = [agent, person];
    render(
      <TestWrapper>
        <NodeRef node={person} readOnly />
      </TestWrapper>
    );

    const pill = screen.getByText('Person').closest('.pill');
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });

  it('shows own color for a class pill with an explicit color', () => {
    const agent = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Agent',
      color: '#ff8800',
      is_class: true,
    });

    classListRef.current = [agent];
    render(
      <TestWrapper>
        <NodeRef node={agent} readOnly />
      </TestWrapper>
    );

    const pill = screen.getByText('Agent').closest('.pill');
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });

  it('shows inherited color when the rendered node lacks extends_uuid but allClasses has it', () => {
    const agent = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Agent',
      color: '#ff8800',
      is_class: true,
    });
    const personFromGenericResponse = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Person',
      color: null,
      is_class: true,
    });
    const canonicalPerson = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Person',
      color: null,
      is_class: true,
      extends_uuid: [agent.uuid],
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
    const agent = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Agent',
      color: null,
      is_class: true,
    });
    const person = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Person',
      color: null,
      is_class: true,
      extends_uuid: [agent.uuid],
    });

    classListRef.current = [agent, person];

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <NodeRef node={person} readOnly />
      </QueryClientProvider>
    );

    expect((screen.getByText('Person').closest('.pill') as HTMLElement).style.backgroundColor).toBe('');

    // Simulate the classes list being re-resolved with a colored parent.
    // The resolved class node for "person" becomes a new object even though
    // its field values are identical.
    const agentWithColor = makeNode({
      uuid: agent.uuid,
      name: agent.name,
      color: '#ff8800',
      is_class: true,
    });
    const freshPerson = makeNode({
      uuid: person.uuid,
      name: person.name,
      color: null,
      is_class: true,
      extends_uuid: [agentWithColor.uuid],
    });

    classListRef.current = [agentWithColor, freshPerson];

    rerender(
      <QueryClientProvider client={queryClient}>
        <NodeRef node={freshPerson} readOnly />
      </QueryClientProvider>
    );

    expect((screen.getByText('Person').closest('.pill') as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });
});
