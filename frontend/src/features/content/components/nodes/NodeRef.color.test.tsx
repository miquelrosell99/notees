import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NodeRef } from './NodeRef';
import { useAuthStore } from '@/stores';
import { nodeKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types';

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

function TestWrapper({ children, allClasses }: { children: React.ReactNode; allClasses: Node[] }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(nodeKeys.classes(), allClasses);
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

    render(
      <TestWrapper allClasses={[agent, person]}>
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

    render(
      <TestWrapper allClasses={[agent]}>
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

    render(
      <TestWrapper allClasses={[agent, canonicalPerson]}>
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

    queryClient.setQueryData(nodeKeys.classes(), [agent, person]);

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <NodeRef node={person} readOnly />
      </QueryClientProvider>
    );

    expect((screen.getByText('Person').closest('.pill') as HTMLElement).style.backgroundColor).toBe('');

    // Simulate the classes query being re-resolved with a colored parent.
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

    queryClient.setQueryData(nodeKeys.classes(), [agentWithColor, freshPerson]);

    rerender(
      <QueryClientProvider client={queryClient}>
        <NodeRef node={freshPerson} readOnly />
      </QueryClientProvider>
    );

    expect((screen.getByText('Person').closest('.pill') as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });
});
