import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeContextMenu } from './NodeContextMenu';
import { usePinnedPagesStore } from '@/stores';
import type { Node } from '@/types';

const baseNode = (isPage: boolean): Node => ({
  uuid: 'node-1',
  name: 'Test node',
  icon: null,
  color: null,
  parent_uuid: null,
  page_uuid: null,
  sequence: 0,
  active: true,
  is_page: isPage,
  create_date: '',
  write_date: '',
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/utils/clipboardManager', () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock('@/stores/clipboardStore', () => ({
  useClipboardStore: (selector: (s: { mode: unknown }) => unknown) => selector({ mode: null }),
}));

vi.mock('@/stores/notificationStore', () => ({
  useNotificationStore: {
    getState: () => ({ addNotification: vi.fn(), removeNotification: vi.fn() }),
  },
}));

vi.mock('@/hooks/useOverlaySurface', () => ({
  useOverlaySurface: () => 'surface-id',
}));

vi.mock('@/components/ui/icons', () => ({
  Icon: ({ path }: { path: string }) => <span data-testid={`icon-${path}`} />,
}));

vi.mock('@/features/content', () => ({
  useArchiveNode: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUnarchiveNode: () => ({ mutate: vi.fn() }),
  useDeleteNode: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateNode: () => ({ mutate: vi.fn() }),
  useLinkedReferencesCount: () => ({ count: 0 }),
  useFavorites: () => ({ data: [] }),
  useAddFavoriteMutation: () => ({ mutate: vi.fn() }),
  useRemoveFavoriteMutation: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/features/queries', () => ({
  nodeNameToDisplayText: (node: Node) => node.name,
  useNodeDisplayName: () => 'Test node',
}));

vi.mock('@/features/layout', () => ({
  useCurrentNodeUuid: () => null,
  useOpenNodeAction: () => vi.fn(),
  useOpenLocalGraphAction: () => vi.fn(),
  useSidebarCards: () => [],
  useAddSidebarCardAction: () => vi.fn(),
  useFlashSidebarCardAction: () => vi.fn(),
}));

vi.mock('@/hooks/useCurrentWorkspaceUuid', () => ({
  useCurrentWorkspaceUuid: () => 'ws-1',
}));

vi.mock('@/features/workspace', () => ({
  ExportPageModal: () => null,
}));

vi.mock('@/api/exportJobs', () => ({
  startSingleExportJob: vi.fn(),
  pollExportJob: vi.fn(),
  fetchExportResult: vi.fn(),
}));

vi.mock('@/plugins/core', () => ({
  useNodeActions: () => [],
  getVisibleNodeActions: () => [],
  NODE_ACTION_DEFAULT_ORDER: 1000,
  NODE_MENU_GROUP_ORDER: ['main', 'edit', 'copy', 'export', 'manage', 'danger'],
}));

vi.mock('./NodeContextMenu/iconRow', () => ({
  IconColorPickerRow: () => <div data-testid="icon-color-row" />,
}));

vi.mock('./NodeContextMenu/moveTo', () => ({
  MoveToSubmenu: () => null,
}));

vi.mock('./ASTViewerModal', () => ({
  ASTViewerModal: () => null,
}));

vi.mock('./ShareModal', () => ({
  ShareModal: () => null,
}));

vi.mock('@/components/ui/ConfirmationModal', () => ({
  ConfirmationModal: () => null,
}));

vi.mock('@/stores', async () => {
  const actual = await vi.importActual('@/stores/pinnedPagesStore');
  return {
    ...actual,
    useSettingsStore: (selector: (s: { showDevOptions: boolean }) => boolean) =>
      selector({ showDevOptions: false }),
    usePresentationStore: { getState: () => ({ openPresentation: vi.fn() }) },
    useUndoStore: { getState: () => ({ performUndo: vi.fn() }) },
  };
});

beforeEach(() => {
  usePinnedPagesStore.setState({ pinnedPages: [] });
});

function renderMenu(node: Node) {
  const onClose = vi.fn();
  render(<NodeContextMenu node={node} position={{ x: 0, y: 0 }} onClose={onClose} />);
  return { onClose };
}

describe('NodeContextMenu pin action', () => {
  function getMenuItemByLabel(label: string) {
    return screen.getByText(label).closest('button') as HTMLButtonElement;
  }

  it('shows "Pin to sidebar" for a page node', () => {
    renderMenu(baseNode(true));
    expect(getMenuItemByLabel('Pin to sidebar')).toBeInTheDocument();
  });

  it('does not show a pin action for a block node', () => {
    renderMenu(baseNode(false));
    expect(screen.queryByText('Pin to sidebar')).not.toBeInTheDocument();
    expect(screen.queryByText('Unpin from sidebar')).not.toBeInTheDocument();
  });

  it('shows "Unpin from sidebar" when the page is already pinned', () => {
    usePinnedPagesStore.setState({ pinnedPages: ['node-1'] });
    renderMenu(baseNode(true));
    expect(getMenuItemByLabel('Unpin from sidebar')).toBeInTheDocument();
  });

  it('pins the page and closes the menu when "Pin to sidebar" is clicked', () => {
    const { onClose } = renderMenu(baseNode(true));
    fireEvent.click(getMenuItemByLabel('Pin to sidebar'));
    expect(usePinnedPagesStore.getState().pinnedPages).toContain('node-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('unpins the page and closes the menu when "Unpin from sidebar" is clicked', () => {
    usePinnedPagesStore.setState({ pinnedPages: ['node-1'] });
    const { onClose } = renderMenu(baseNode(true));
    fireEvent.click(getMenuItemByLabel('Unpin from sidebar'));
    expect(usePinnedPagesStore.getState().pinnedPages).not.toContain('node-1');
    expect(onClose).toHaveBeenCalled();
  });
});
