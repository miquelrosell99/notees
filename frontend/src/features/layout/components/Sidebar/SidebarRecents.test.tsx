import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SidebarRecents } from './SidebarRecents';
import { useRecentsStore } from '@/stores/recentsStore';

vi.mock('@/features/content', async () => {
  const { useRecentsStore: store } = await import('@/stores/recentsStore');
  return {
    useNodeByUuid: (uuid: string | null) => ({
      data: uuid ? { uuid, name: 'Test Page', is_page: true } : undefined,
    }),
    useNodeDisplay: () => ({ effectiveIcon: null }),
    NodeInline: () => null,
    NodeBreadcrumbs: () => null,
    useRecents: (limit = 10) => ({
      data: store((s) => s.recents).slice(0, limit),
      isLoading: false,
      error: null,
    }),
    removeRecent: (uuid: string) => store.getState().removeRecent(uuid),
  };
});

vi.mock('@/features/queries', () => ({
  useNodeDisplayName: (node?: { name?: string }) => node?.name ?? '',
  nodeNameToDisplayText: (node?: { name?: string } | null) => node?.name ?? '',
}));

describe('SidebarRecents', () => {
  beforeEach(() => {
    useRecentsStore.setState({
      recents: [{ nodeUuid: 'page-1', openDate: '2026-09-01T00:00:00.000Z' }],
    });
  });

  it('asks for confirmation before removing an item', () => {
    render(<SidebarRecents onContextMenu={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from recents' }));
    expect(screen.getByText('Remove "Test Page" from recents?')).toBeInTheDocument();
    // Not removed until confirmed
    expect(useRecentsStore.getState().recents).toHaveLength(1);
  });

  it('removes the item from recents on confirm', async () => {
    render(<SidebarRecents onContextMenu={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from recents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    // Flush the async handleConfirm continuation inside act().
    await act(async () => {});
    expect(useRecentsStore.getState().recents).toHaveLength(0);
  });

  it('keeps the item when cancelling', () => {
    render(<SidebarRecents onContextMenu={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from recents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useRecentsStore.getState().recents).toHaveLength(1);
  });
});
