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
import { setOperationRuntime } from '@/runtime/runtimeInstance';
import { resetRuntimeEventBus } from '@/runtime/eventBus';
import { OperationRuntime } from '@/runtime/OperationRuntime';
import type { Node } from '@/types/api';

const PAGE_UUID = '11111111-1111-1111-1111-111111111111';
const FOCUSED_UUID = '22222222-2222-2222-2222-222222222222';
const CHILD_UUID = '33333333-3333-3333-3333-333333333333';

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
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

vi.mock('@/features/editor', () => ({
  CustomInlineEditor: vi.fn(() => <div data-testid="inline-editor">Editor</div>),
  InlineContentStatic: vi.fn(() => <div data-testid="inline-static">Static</div>),
  flushAllContentSaves: vi.fn(),
  BlockFindReplacePlugin: vi.fn(() => null),
}));


const { applyIntentMock } = vi.hoisted(() => ({ applyIntentMock: vi.fn() }));

vi.mock('@/stores/undoEngine', () => ({
  getUndoEngine: vi.fn(() => ({
    applyIntent: applyIntentMock,
  })),
}));

describe('BlockList focused block view', () => {
  beforeEach(() => {
    useEditorFocusStore.setState({ activeBlockId: null, pendingFocusBlockId: null });
    useBlockSelectionStore.setState({ selectedIds: new Set(), anchorId: null, focusId: null, isDragging: false });
    const runtime = new OperationRuntime();
    setOperationRuntime(runtime);
    resetRuntimeEventBus(runtime);
    applyIntentMock.mockClear();
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

    applyIntentMock.mockClear();
    fireEvent.click(rootGhost);

    await waitFor(() => {
      expect(applyIntentMock).toHaveBeenCalledTimes(1);
    });

    const intent = applyIntentMock.mock.calls[0][0];
    expect(intent.type).toBe('create_block');
    expect(intent.parentId).toBe(FOCUSED_UUID);
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

    useBlockSelectionStore.getState().setSelectedIds([CHILD_UUID, '55555555-5555-5555-5555-555555555555']);

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
      expect(applyIntentMock).toHaveBeenCalledTimes(1);
    });

    const intent = applyIntentMock.mock.calls[0][0];
    expect(intent.type).toBe('batch');
    expect(intent.intents).toEqual([
      { type: 'move_block', blockId: CHILD_UUID, newParentId: PREV_UUID, afterBlockId: null },
      { type: 'move_block', blockId: '55555555-5555-5555-5555-555555555555', newParentId: PREV_UUID, afterBlockId: CHILD_UUID },
    ]);
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

    useBlockSelectionStore.getState().setSelectedIds([CHILD_UUID, '66666666-6666-6666-6666-666666666666']);

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
      expect(applyIntentMock).toHaveBeenCalledTimes(1);
    });

    const intent = applyIntentMock.mock.calls[0][0];
    expect(intent.type).toBe('batch');
    expect(intent.intents).toEqual([
      { type: 'outdent_block', blockId: CHILD_UUID },
      { type: 'outdent_block', blockId: '66666666-6666-6666-6666-666666666666' },
    ]);
  });
});
