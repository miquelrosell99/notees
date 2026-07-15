import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TasksPopup } from './TasksPopup';
import { useNavigationStore } from '@/stores';
import type { PopupSectionData } from '@/features/tasks/hooks/useTasksPopupData';

const setTaskStatusMock = vi.fn();
// The real quickAdd returns Promise<void>; the popup calls `.catch` on it,
// so the mock must resolve (a bare vi.fn() would return undefined).
const quickAddMock = vi.fn().mockResolvedValue(undefined);

const sections: Record<string, PopupSectionData> = {
  overdue: { nodes: [{ uuid: 'o1', name: 'Overdue task', page_name: 'Journal' }] as never, totalCount: 1 },
  today: { nodes: [{ uuid: 't1', name: 'Today task', page_name: 'Journal' }] as never, totalCount: 1 },
  upcoming: {
    nodes: [{
      uuid: 'u1', name: 'Future task', page_name: 'Journal',
      properties_uuid: { '00000000-0000-0000-0003-000000000003': '00000000-0000-0000-00dd-202607200000' },
    }] as never,
    totalCount: 1,
  },
  completed: { nodes: [{ uuid: 'c1', name: 'Done task', page_name: 'Journal' }] as never, totalCount: 1 },
};

vi.mock('@/features/tasks/hooks/useTasksPopupData', () => ({
  useTasksPopupData: () => ({
    sections, dueCount: 2, isLoading: false, isError: false, refetch: vi.fn(),
  }),
  getTaskDateUuid: (n: { properties_uuid?: Record<string, string> }) =>
    n.properties_uuid?.['00000000-0000-0000-0003-000000000003'] ?? null,
}));
vi.mock('@/features/tasks/hooks/useSetTaskStatus', () => ({
  useSetTaskStatus: () => setTaskStatusMock,
}));
vi.mock('@/features/tasks/hooks/useQuickAddTask', () => ({
  useQuickAddTask: () => ({ quickAdd: quickAddMock, isAdding: false }),
}));
vi.mock('@/hooks/useViewportFlip', () => ({
  useViewportFlip: () => ({ top: 0, left: 0 }),
}));

function renderPopup(onClose = vi.fn()) {
  return render(
    <TasksPopup isOpen onClose={onClose} anchorRef={{ current: null }} />,
  );
}

describe('TasksPopup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNavigationStore.setState({ openNode: vi.fn() } as never);
  });

  it('renders all four sections with their rows', () => {
    renderPopup();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Completed today')).toBeInTheDocument();
    expect(screen.getByText('Overdue task')).toBeInTheDocument();
    expect(screen.getByText('Done task')).toBeInTheDocument();
  });

  it('checking an open task sets it Done; unchecking a completed one sets Pending', () => {
    renderPopup();
    fireEvent.click(screen.getByRole('button', { name: /mark "today task" as done/i }));
    expect(setTaskStatusMock).toHaveBeenCalledWith('t1', 'Done');
    fireEvent.click(screen.getByRole('button', { name: /mark "done task" as not done/i }));
    expect(setTaskStatusMock).toHaveBeenCalledWith('c1', 'Pending');
  });

  it('clicking a task title navigates and closes', () => {
    const onClose = vi.fn();
    renderPopup(onClose);
    fireEvent.click(screen.getByText('Today task'));
    expect(useNavigationStore.getState().openNode).toHaveBeenCalledWith('t1');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderPopup(onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('quick-add submits the trimmed name and clears the input', () => {
    renderPopup();
    const input = screen.getByPlaceholderText(/add a task/i);
    fireEvent.change(input, { target: { value: '  New thing  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(quickAddMock).toHaveBeenCalledWith('  New thing  ');
    expect((input as HTMLInputElement).value).toBe('');
  });
});
