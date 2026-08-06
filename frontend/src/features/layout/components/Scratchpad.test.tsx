/**
 * Scratchpad tests
 *
 * Focuses on the transient-block behavior: blocks live in component state, the
 * badge count comes from that local state, and the list is rendered in
 * local-only mode with a ghost block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Scratchpad } from './Scratchpad';
import { SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';
import type { Node } from '@/types';

const SCRATCHPAD_PAGE: Node = {
  uuid: SYSTEM_PAGE_UUIDS.scratchpad,
  name: 'Scratchpad',
  icon: null,
  color: null,
  parent_uuid: null,
  page_uuid: null,
  sequence: 0,
  active: true,
  is_page: true,
  create_date: new Date().toISOString(),
  write_date: new Date().toISOString(),
};

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

vi.mock('@/features/content', () => ({
  BlockList: vi.fn(() => <div data-testid="block-list" />),
  NodeSelector: vi.fn(() => <div data-testid="node-selector" />),
  useTodayNote: vi.fn(() => ({ data: null })),
  usePages: vi.fn(() => ({ data: [] })),
  useNodeByUuid: vi.fn(() => ({ data: SCRATCHPAD_PAGE })),
  useCreateNode: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useDeleteNode: vi.fn(() => ({ mutate: vi.fn() })),
}));

vi.mock('@/features/editor', () => ({
  flushAllContentSaves: vi.fn(),
}));

vi.mock('@/hooks/useFocusTrap', () => ({
  useFocusTrap: vi.fn(),
}));

vi.mock('@/hooks/useOverlaySurface', () => ({
  useOverlaySurface: vi.fn(),
}));

vi.mock('@/stores', () => ({
  useSettingsStore: vi.fn(() => ({ quickAddDestination: 'inbox' })),
}));

vi.mock('@/stores/editorFocusStore', () => ({
  useEditorFocusStore: {
    getState: vi.fn(() => ({ setPendingFocus: vi.fn() })),
  },
}));

vi.mock('@/core/uuid', () => ({
  uuidv7: vi.fn(() => 'transient-block-uuid'),
}));

vi.mock('@/components/ui/Button', () => ({
  Button: vi.fn(({ children, active: _active, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode; active?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  )),
}));

describe('Scratchpad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders in local-only mode with no initial transient blocks', async () => {
    const { BlockList } = await import('@/features/content');
    const onEntryCountChange = vi.fn();

    render(
      <Scratchpad isOpen onClose={vi.fn()} onEntryCountChange={onEntryCountChange} />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('block-list')).toBeInTheDocument();
    const blockListCall = vi.mocked(BlockList).mock.calls[0];
    expect(blockListCall?.[0]).toEqual(
      expect.objectContaining({
        nodes: [],
        localOnly: true,
        nodeUuid: SYSTEM_PAGE_UUIDS.scratchpad,
      }),
    );
    expect(onEntryCountChange).toHaveBeenCalledWith(0);
  });

  it('deletes any previously persisted scratchpad children on first load', async () => {
    const { useNodeByUuid, useDeleteNode } = await import('@/features/content');
    const persistedChild = { ...SCRATCHPAD_PAGE, uuid: 'persisted-child-uuid' };
    vi.mocked(useNodeByUuid).mockReturnValue({
      data: { ...SCRATCHPAD_PAGE, children: [persistedChild] },
    } as ReturnType<typeof useNodeByUuid>);
    const deleteMutate = vi.fn();
    vi.mocked(useDeleteNode).mockReturnValue({ mutate: deleteMutate } as unknown as ReturnType<typeof useDeleteNode>);

    render(<Scratchpad isOpen onClose={vi.fn()} />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(deleteMutate).toHaveBeenCalledWith('persisted-child-uuid');
    });
  });

  it('adds a transient block when the ghost block is realized and reports the count', async () => {
    const { BlockList } = await import('@/features/content');
    const onEntryCountChange = vi.fn();

    render(
      <Scratchpad isOpen onClose={vi.fn()} onEntryCountChange={onEntryCountChange} />,
      { wrapper: Wrapper },
    );

    const firstCall = vi.mocked(BlockList).mock.calls[0];
    const props = firstCall?.[0] as { onGhostRealize?: () => void };
    await act(async () => {
      props.onGhostRealize?.();
    });

    await waitFor(() => {
      const lastCall = vi.mocked(BlockList).mock.lastCall;
      const lastProps = lastCall?.[0] as { nodes: Node[] };
      expect(lastProps.nodes).toHaveLength(1);
      expect(lastProps.nodes[0]?.uuid).toBe('transient-block-uuid');
    });
    expect(onEntryCountChange).toHaveBeenLastCalledWith(1);
  });
});
