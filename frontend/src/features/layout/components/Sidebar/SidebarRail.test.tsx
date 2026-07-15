import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarRail } from './NavigationSidebar';
import { useNavigationStore } from '@/stores';

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
  });

  it('shows a Tasks button', () => {
    render(<SidebarRail />);
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('opens the tasks view when clicked', async () => {
    render(<SidebarRail />);
    await userEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(useNavigationStore.getState().mainViewType).toBe('tasks');
  });

  it('marks the Tasks button active while the tasks view is open', () => {
    useNavigationStore.setState({ mainViewType: 'tasks' });
    render(<SidebarRail />);
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveClass('btn--active');
  });
});
