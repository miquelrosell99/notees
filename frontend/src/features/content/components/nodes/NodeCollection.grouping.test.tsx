/**
 * NodeCollection list-mode grouping tests.
 *
 * Grouping must be driven by the active group-by value alone — not by the
 * group-by selector visibility (showGroupBy). A collection without the
 * selector (e.g. the Tasks view) still groups list rows when a group-by
 * value is active, and stays flat when groupBy is 'none'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NodeCollection } from './NodeCollection';
import { useAuthStore } from '@/stores';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';
import type { Node } from '@/types';

const PAGE_ONE_UUID = '11111111-1111-1111-1111-111111111111';
const PAGE_TWO_UUID = '22222222-2222-2222-2222-222222222222';
const BLOCK_ONE_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BLOCK_TWO_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeTaskNode(overrides: Partial<Node> = {}): Node {
  return {
    uuid: BLOCK_ONE_UUID,
    name: 'Task',
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    is_deleted: false,
    has_children: false,
    children: [],
    create_date: '2024-01-01T00:00:00Z',
    write_date: '2024-01-01T00:00:00Z',
    classes_uuid: [],
    tags_uuid: [],
    properties_uuid: {},
    ...overrides,
  } as Node;
}

// Two blocks belonging to two different pages, as returned by task queries.
const taskNodes: Node[] = [
  makeTaskNode({
    uuid: BLOCK_ONE_UUID,
    name: 'Task one',
    page_uuid: PAGE_ONE_UUID,
    page_name: 'Alpha page',
  }),
  makeTaskNode({
    uuid: BLOCK_TWO_UUID,
    name: 'Task two',
    page_uuid: PAGE_TWO_UUID,
    page_name: 'Beta page',
  }),
];

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

vi.mock('@/features/sync', () => ({
  useUIStateStore: vi.fn(() => ({
    states: {},
    toggleCollapsed: vi.fn(),
    getNodeUIState: vi.fn(() => undefined),
    setCollapsed: vi.fn(),
  })),
  useFoldKeyboardShortcut: vi.fn(),
}));

vi.mock('@/features/content/hooks/useBlockDragDrop', () => ({
  useBlockDragDrop: vi.fn(),
}));

vi.mock('@/features/content/hooks/useBlockSelection', () => ({
  useBlockSelection: vi.fn(),
}));

vi.mock('@/features/content/hooks/useTouchIndent', () => ({
  useTouchIndent: vi.fn(),
}));

vi.mock('@/features/properties', () => ({
  useProperties: vi.fn(() => ({ data: [] })),
  useSetNodeProperty: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn() })),
  PropertyIconButton: vi.fn(() => null),
  PropertiesSection: vi.fn(() => null),
}));

vi.mock('@/features/editor', () => ({
  CustomInlineEditor: vi.fn(() => <div data-testid="inline-editor">Editor</div>),
  InlineContentStatic: vi.fn(() => <div data-testid="inline-static">Static</div>),
  flushAllContentSaves: vi.fn(),
  BlockFindReplacePlugin: vi.fn(() => null),
}));

describe('NodeCollection list-mode grouping', () => {
  beforeEach(() => {
    useAuthStore.setState({ authVerified: false });
    useEditorFocusStore.setState({ activeBlockId: null, pendingFocusBlockId: null });
    useBlockSelectionStore.setState({ selectedIds: new Set(), anchorId: null, focusId: null, isDragging: false });
  });

  it('groups list-mode rows by page even without the group-by selector', () => {
    // No showGroupBy prop and no groupBy prop — groupBy defaults to 'page'.
    const { container } = render(
      <NodeCollection nodes={taskNodes} viewMode="list" editable={false} hideToolbar />,
      { wrapper: Wrapper },
    );

    const headers = container.querySelectorAll('.node-list-view__group-header');
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toContain('Alpha page');
    expect(headers[1].textContent).toContain('Beta page');
  });

  it('renders flat when groupBy is none', () => {
    const { container } = render(
      <NodeCollection nodes={taskNodes} viewMode="list" editable={false} hideToolbar groupBy="none" />,
      { wrapper: Wrapper },
    );

    expect(container.querySelectorAll('.node-list-view__group-header')).toHaveLength(0);
    expect(container.querySelector('.node-list-view--grouped')).toBeNull();
    // Rows still render — just ungrouped.
    expect(screen.getByText('Task one')).toBeInTheDocument();
    expect(screen.getByText('Task two')).toBeInTheDocument();
  });
});
