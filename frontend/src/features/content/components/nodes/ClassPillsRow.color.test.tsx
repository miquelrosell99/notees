import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClassPillsRow } from './ClassPillsRow';
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

describe('ClassPillsRow inherited color', () => {
  beforeEach(() => {
    useAuthStore.setState({ authVerified: true });
  });

  it('renders a class pill with the color inherited from its parent class', () => {
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
        <ClassPillsRow classes={[person]} nodeUuid="page-uuid" readOnly />
      </TestWrapper>
    );

    const pill = screen.getByText('Person').closest('.pill');
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.backgroundColor).toBe('rgb(255, 136, 0)');
  });
});
