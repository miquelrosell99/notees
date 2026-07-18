/**
 * BlockList focused-block-view integration test.
 *
 * Renders BlockList with rootIsBlock=true and verifies that clicking the
 * trailing ghost block creates a new block as a child of the focused block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BlockList } from './BlockList';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';
import { useBlockTree } from '@/features/content/hooks/useBlockTree';
import { useWorkspaceStore } from '@/core/hooks';
import type { Node } from '@/types/api';
import type { FlatNode } from '@/features/content/hooks/useBlockTree';
import type { WorkspaceStore } from '@/core/store';

const PAGE_UUID = '11111111-1111-1111-1111-111111111111';
const FOCUSED_UUID = '22222222-2222-2222-2222-222222222222';
const CHILD_UUID = '33333333-3333-3333-3333-333333333333';

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function ghostNode(parentUuid: string, depth: number): FlatNode {
  return {
    node: {
      uuid: `__ghost-${parentUuid}`,
      name: '',
      icon: null,
      color: null,
      parent_uuid: null,
      page_uuid: null,
      sequence: Number.MAX_SAFE_INTEGER,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: false,
      children: [],
      create_date: '',
      write_date: '',
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    },
    depth,
    effectiveCollapsed: false,
    isGhost: true,
  };
}

function nodeToFlat(node: Node, depth: number): FlatNode {
  return { node, depth, effectiveCollapsed: false };
}

function seedRuntime(nodes: Node[], parentId: string | null = null): void {
  for (const node of nodes) {
    runtimeNodesMock.set(node.uuid, {
      blockId: node.uuid,
      parentId,
      children: node.children?.map((c) => c.uuid) ?? [],
    });
    if (node.children) {
      seedRuntime(node.children, node.uuid);
    }
  }
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

vi.mock('@/features/content/hooks/useBlockTree', () => ({
  useBlockTree: vi.fn(),
  isGhostId: vi.fn((uuid: string) => uuid.startsWith('__ghost-')),
  buildGhostId: vi.fn((parentUuid: string) => `__ghost-${parentUuid}`),
  parseGhostParentUuid: vi.fn((ghostUuid: string) =>
    ghostUuid.startsWith('__ghost-') ? ghostUuid.slice('__ghost-'.length) : null
  ),
  isValidServerNodeId: vi.fn((uuid: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)
  ),
}));

const {
  runtimeNodesMock,
  mockStore,
  createBlockMock,
  moveBlockMock,
  deleteBlockMock,
  splitBlockMock,
  mergeBlocksMock,
  indentBlockMock,
  outdentBlockMock,
  pasteBlocksAfterMock,
} = vi.hoisted(() => {
  const runtimeNodesMock = new Map<string, { blockId: string; parentId: string | null; children: string[] }>();

  const mockStore = {
    getNode: vi.fn((id: string) => {
      const entry = runtimeNodesMock.get(id);
      if (!entry) return undefined;
      return { id: entry.blockId, parentId: entry.parentId };
    }),
    getChildren: vi.fn((id: string) => {
      const entry = runtimeNodesMock.get(id);
      return entry?.children ?? [];
    }),
    subscribe: vi.fn(() => vi.fn()),
  };

  return {
    runtimeNodesMock,
    mockStore,
    createBlockMock: vi.fn(async () => 'new-block-uuid'),
    moveBlockMock: vi.fn(async () => {}),
    deleteBlockMock: vi.fn(async () => {}),
    splitBlockMock: vi.fn(async () => 'split-block-uuid'),
    mergeBlocksMock: vi.fn(async () => {}),
    indentBlockMock: vi.fn(async () => {}),
    outdentBlockMock: vi.fn(async () => {}),
    pasteBlocksAfterMock: vi.fn(async () => {}),
  };
});

vi.mock('@/core/hooks', () => ({
  useWorkspaceStore: vi.fn(() => ({ store: mockStore as unknown as WorkspaceStore, isLoading: false, error: null })),
  useNode: vi.fn(() => ({ node: undefined, isLoading: false })),
  useChildren: vi.fn(() => ({ children: [], isLoading: false })),
}));

vi.mock('@/features/content/hooks/useCoreBlockMutations', () => ({
  useCoreBlockMutations: vi.fn(() => ({
    createBlock: createBlockMock,
    moveBlock: moveBlockMock,
    deleteBlock: deleteBlockMock,
    splitBlock: splitBlockMock,
    mergeBlocks: mergeBlocksMock,
    indentBlock: indentBlockMock,
    outdentBlock: outdentBlockMock,
    pasteBlocksAfter: pasteBlocksAfterMock,
  })),
}));

describe('BlockList focused block view', () => {
  beforeEach(() => {
    useEditorFocusStore.setState({ activeBlockId: null, pendingFocusBlockId: null });
    useBlockSelectionStore.setState({ selectedIds: new Set(), anchorId: null, focusId: null, isDragging: false });

    createBlockMock.mockClear();
    moveBlockMock.mockClear();
    deleteBlockMock.mockClear();
    splitBlockMock.mockClear();
    mergeBlocksMock.mockClear();
    indentBlockMock.mockClear();
    outdentBlockMock.mockClear();
    pasteBlocksAfterMock.mockClear();

    vi.mocked(useBlockTree).mockReset();
    vi.mocked(useWorkspaceStore).mockReturnValue({
      store: mockStore as unknown as WorkspaceStore,
      isLoading: false,
      error: null,
    });

    runtimeNodesMock.clear();
    mockStore.getNode.mockClear();
    mockStore.getChildren.mockClear();
    mockStore.subscribe.mockClear();
  });

  it('renders focused block, child, and ghost', () => {
    const focusedBlock: Node = {
      uuid: FOCUSED_UUID,
      name: 'Focused block',
      icon: null,
      color: null,
      parent_uuid: PAGE_UUID,
      page_uuid: null,
      sequence: 0,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: true,
      children: [
        {
          uuid: CHILD_UUID,
          name: 'Child block',
          icon: null,
          color: null,
          parent_uuid: FOCUSED_UUID,
          page_uuid: null,
          sequence: 0,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: false,
          children: [],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
      ],
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    };

    vi.mocked(useBlockTree).mockReturnValue({
      flatNodes: [
        nodeToFlat(focusedBlock, 0),
        nodeToFlat(focusedBlock.children![0], 1),
        ghostNode(CHILD_UUID, 2),
        ghostNode(FOCUSED_UUID, 1),
      ],
      structureVersion: 0,
    });

    render(
      <BlockList
        nodes={[focusedBlock]}
        nodeUuid={FOCUSED_UUID}
        rootIsBlock
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('Focused block')).toBeInTheDocument();
    expect(screen.getByText('Child block')).toBeInTheDocument();
    // Two ghosts: one inside the child block (depth 2) and the root ghost (depth 1).
    expect(screen.getAllByLabelText('Add block')).toHaveLength(2);
  });

  it('creates a child of the focused block when the root ghost is clicked', async () => {
    const focusedBlock: Node = {
      uuid: FOCUSED_UUID,
      name: 'Focused block',
      icon: null,
      color: null,
      parent_uuid: PAGE_UUID,
      page_uuid: null,
      sequence: 0,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: true,
      children: [
        {
          uuid: CHILD_UUID,
          name: 'Child block',
          icon: null,
          color: null,
          parent_uuid: FOCUSED_UUID,
          page_uuid: null,
          sequence: 0,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: false,
          children: [],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
      ],
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    };

    vi.mocked(useBlockTree).mockReturnValue({
      flatNodes: [
        nodeToFlat(focusedBlock, 0),
        nodeToFlat(focusedBlock.children![0], 1),
        ghostNode(CHILD_UUID, 2),
        ghostNode(FOCUSED_UUID, 1),
      ],
      structureVersion: 0,
    });

    render(
      <BlockList
        nodes={[focusedBlock]}
        nodeUuid={FOCUSED_UUID}
        rootIsBlock
      />,
      { wrapper: Wrapper },
    );

    const rootGhost = document.querySelector(
      `[data-block-id="__ghost-${FOCUSED_UUID}"] button[aria-label="Add block"]`,
    ) as HTMLElement;
    expect(rootGhost).toBeTruthy();

    fireEvent.click(rootGhost);

    await waitFor(() => {
      expect(createBlockMock).toHaveBeenCalledTimes(1);
    });

    expect(createBlockMock).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: FOCUSED_UUID }),
    );
  });

  it('indents multiple selected blocks under the preceding sibling on Tab', async () => {
    const PREV_UUID = '44444444-4444-4444-4444-444444444444';

    const focusedBlock: Node = {
      uuid: FOCUSED_UUID,
      name: 'Focused block',
      icon: null,
      color: null,
      parent_uuid: PAGE_UUID,
      page_uuid: null,
      sequence: 0,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: true,
      children: [
        {
          uuid: PREV_UUID,
          name: 'Previous',
          icon: null,
          color: null,
          parent_uuid: FOCUSED_UUID,
          page_uuid: null,
          sequence: 0,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: false,
          children: [],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
        {
          uuid: CHILD_UUID,
          name: 'Child block',
          icon: null,
          color: null,
          parent_uuid: FOCUSED_UUID,
          page_uuid: null,
          sequence: 1,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: false,
          children: [],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
        {
          uuid: '55555555-5555-5555-5555-555555555555',
          name: 'Another child',
          icon: null,
          color: null,
          parent_uuid: FOCUSED_UUID,
          page_uuid: null,
          sequence: 2,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: false,
          children: [],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
      ],
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    };

    const child1 = focusedBlock.children![0];
    const child2 = focusedBlock.children![1];
    const child3 = focusedBlock.children![2];

    seedRuntime([focusedBlock]);

    useBlockSelectionStore.getState().setSelectedIds([CHILD_UUID, '55555555-5555-5555-5555-555555555555']);

    vi.mocked(useBlockTree).mockReturnValue({
      flatNodes: [
        nodeToFlat(focusedBlock, 0),
        nodeToFlat(child1, 1),
        ghostNode(PREV_UUID, 2),
        nodeToFlat(child2, 1),
        ghostNode(CHILD_UUID, 2),
        nodeToFlat(child3, 1),
        ghostNode('55555555-5555-5555-5555-555555555555', 2),
        ghostNode(FOCUSED_UUID, 1),
      ],
      structureVersion: 0,
    });

    render(
      <BlockList
        nodes={[focusedBlock]}
        nodeUuid={FOCUSED_UUID}
        rootIsBlock
      />,
      { wrapper: Wrapper },
    );

    const container = screen.getByRole('application');
    fireEvent.keyDown(container, { key: 'Tab' });

    await waitFor(() => {
      expect(moveBlockMock).toHaveBeenCalledTimes(2);
    });

    expect(moveBlockMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ blockId: CHILD_UUID, newParentId: PREV_UUID }),
    );
    expect(moveBlockMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ blockId: '55555555-5555-5555-5555-555555555555', newParentId: PREV_UUID }),
    );
  });

  it('outdents multiple selected blocks with Shift+Tab', async () => {
    const focusedBlock: Node = {
      uuid: FOCUSED_UUID,
      name: 'Focused block',
      icon: null,
      color: null,
      parent_uuid: PAGE_UUID,
      page_uuid: null,
      sequence: 0,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: true,
      children: [
        {
          uuid: CHILD_UUID,
          name: 'Child block',
          icon: null,
          color: null,
          parent_uuid: FOCUSED_UUID,
          page_uuid: null,
          sequence: 0,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: false,
          children: [],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
        {
          uuid: '66666666-6666-6666-6666-666666666666',
          name: 'Sibling child',
          icon: null,
          color: null,
          parent_uuid: FOCUSED_UUID,
          page_uuid: null,
          sequence: 1,
          active: true,
          is_page: false,
          is_deleted: false,
          has_children: false,
          children: [],
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          classes_uuid: [],
          tags_uuid: [],
          properties_uuid: {},
        },
      ],
      create_date: new Date().toISOString(),
      write_date: new Date().toISOString(),
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    };

    const child1 = focusedBlock.children![0];
    const child2 = focusedBlock.children![1];

    seedRuntime([focusedBlock]);

    useBlockSelectionStore.getState().setSelectedIds([CHILD_UUID, '66666666-6666-6666-6666-666666666666']);

    vi.mocked(useBlockTree).mockReturnValue({
      flatNodes: [
        nodeToFlat(focusedBlock, 0),
        nodeToFlat(child1, 1),
        ghostNode(CHILD_UUID, 2),
        nodeToFlat(child2, 1),
        ghostNode('66666666-6666-6666-6666-666666666666', 2),
        ghostNode(FOCUSED_UUID, 1),
      ],
      structureVersion: 0,
    });

    render(
      <BlockList
        nodes={[focusedBlock]}
        nodeUuid={FOCUSED_UUID}
        rootIsBlock
      />,
      { wrapper: Wrapper },
    );

    const container = screen.getByRole('application');
    fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });

    await waitFor(() => {
      expect(outdentBlockMock).toHaveBeenCalledTimes(2);
    });

    expect(outdentBlockMock).toHaveBeenNthCalledWith(1, { blockId: CHILD_UUID });
    expect(outdentBlockMock).toHaveBeenNthCalledWith(2, { blockId: '66666666-6666-6666-6666-666666666666' });
  });
});
