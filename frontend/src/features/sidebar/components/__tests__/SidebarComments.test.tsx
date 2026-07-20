import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarComments } from '../SidebarComments';
import type { Node } from '@/types/api';

const baseComment = (overrides: Partial<Node> = {}): Node => ({
  uuid: 'comment-a',
  name: 'Top-level comment',
  icon: null,
  color: null,
  parent_uuid: 'page-1',
  page_uuid: 'page-1',
  sequence: 0,
  active: true,
  is_page: false,
  classes_uuid: ['comment-class'],
  tags_uuid: [],
  properties_uuid: {},
  create_date: '',
  write_date: '',
  children: [],
  has_children: false,
  ...overrides,
});

vi.mock('@/stores', () => ({
  useNavigationStore: () => ({ openNode: vi.fn() }),
}));

vi.mock('@/features/content/hooks/useComments', () => ({
  useComments: () => ({ data: { comments: [], comment_count: 0 }, isLoading: false }),
  useCommentCount: () => ({ data: 0, isLoading: false }),
  useCreateComment: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
  useDeleteComment: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function expandSection() {
  fireEvent.click(screen.getByRole('button', { name: /expand section/i }));
}

describe('SidebarComments', () => {
  it('renders top-level comments', () => {
    const comments: Node[] = [baseComment({ uuid: 'c1', name: 'First comment' })];

    render(
      <SidebarComments
        nodeUuid="page-1"
        comments={comments}
        count={comments.length}
        loading={false}
      />,
      { wrapper: Wrapper }
    );

    expandSection();

    expect(screen.getByText('First comment')).toBeInTheDocument();
  });

  it('renders nested replies under their parent comment', () => {
    const reply: Node = baseComment({
      uuid: 'c1-reply',
      name: 'Nested reply',
      parent_uuid: 'c1',
      page_uuid: 'page-1',
    });
    const comments: Node[] = [
      baseComment({
        uuid: 'c1',
        name: 'Parent comment',
        children: [reply],
        has_children: true,
      }),
    ];

    render(
      <SidebarComments
        nodeUuid="page-1"
        comments={comments}
        count={comments.length}
        loading={false}
      />,
      { wrapper: Wrapper }
    );

    expandSection();

    expect(screen.getByText('Parent comment')).toBeInTheDocument();
    expect(screen.getByText('Nested reply')).toBeInTheDocument();
  });

  it('renders reply affordance for every comment including nested ones', () => {
    const reply: Node = baseComment({
      uuid: 'c1-reply',
      name: 'Nested reply',
      parent_uuid: 'c1',
      page_uuid: 'page-1',
    });
    const comments: Node[] = [
      baseComment({
        uuid: 'c1',
        name: 'Parent comment',
        children: [reply],
        has_children: true,
      }),
    ];

    render(
      <SidebarComments
        nodeUuid="page-1"
        comments={comments}
        count={comments.length}
        loading={false}
      />,
      { wrapper: Wrapper }
    );

    expandSection();

    const replyButtons = screen.getAllByTitle('Reply');
    expect(replyButtons).toHaveLength(2);
  });
});
