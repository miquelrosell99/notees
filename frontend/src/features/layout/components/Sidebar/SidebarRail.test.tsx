import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  it('shows the Pages button', () => {
    useNavigationStore.setState({ mainViewType: 'pages' });
    render(<SidebarRail />);
    expect(screen.getByRole('button', { name: 'Pages' })).toBeInTheDocument();
  });
});
