import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarRail } from './NavigationSidebar';
import { useModalStore, useNavigationStore } from '@/stores';

vi.mock('@/features/workspace', () => ({
  WorkspaceSwitcher: () => null,
  useWorkspaceSettings: () => ({
    data: { sidebar_show_journals: true, sidebar_show_inbox: true },
  }),
  useEmptyTrash: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/features/content', () => ({
  useNodeByUuid: () => ({ data: { uuid: 'inbox-uuid' } }),
  useDailyNote: () => ({ refetch: vi.fn() }),
  PageContextMenu: () => null,
}));

vi.mock('@/features/layout/components/AccountMenu', () => ({
  AccountMenu: () => null,
}));

vi.mock('@/features/layout/components/Modals', () => ({
  GraphSettingsModal: () => null,
  UserSettingsModal: () => null,
  SystemSettingsModal: () => null,
}));

vi.mock('@/features/support', () => ({
  SupportBadge: () => null,
}));

describe('SidebarRail', () => {
  beforeEach(() => {
    useNavigationStore.setState({ mainViewType: 'pages' });
    useModalStore.setState({ isTasksPopupOpen: false });
  });

  it('shows a Tasks button', () => {
    render(<SidebarRail />);
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('opens the tasks popup from the rail button', () => {
    useModalStore.setState({ isTasksPopupOpen: false });
    render(<SidebarRail />);
    fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
    expect(useModalStore.getState().isTasksPopupOpen).toBe(true);
  });

  it('shows the rail tasks button active while the popup is open', () => {
    useModalStore.setState({ isTasksPopupOpen: true });
    render(<SidebarRail />);
    expect(screen.getByRole('button', { name: /^tasks$/i }).className).toContain('btn--active');
  });
});
