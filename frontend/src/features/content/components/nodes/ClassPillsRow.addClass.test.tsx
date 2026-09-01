import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClassPillsRow } from './ClassPillsRow';
import { TriggerPopup } from '@/features/editor/editor/plugins/TriggerPopup';
import type { TriggerPopupProps } from '@/features/editor/editor/plugins/TriggerPopup';
import { useAuthStore } from '@/stores';
import type { Node } from '@/types';

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ workspaceId: 'ws-test' })),
}));

// The component lazy-imports the popup from this module; mocking here covers
// both the lazy import and this test's static import for assertions.
vi.mock('@/features/editor/editor/plugins/TriggerPopup', () => ({
  TriggerPopup: vi.fn(() => <div data-testid="trigger-popup" />),
}));

vi.mock('@/core/hooks', () => ({
  useWorkspaceStoreClient: vi.fn(() => ({ client: null, isLoading: false, error: null })),
  useNode: vi.fn(() => ({ node: undefined, isLoading: false })),
  useUndoManager: vi.fn(() => undefined),
  useClasses: vi.fn(() => ({ data: [], isLoading: false, error: null })),
}));

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    uuid: '00000000-0000-0000-0000-000000000000',
    name: 'Test Node',
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: true,
    create_date: '2024-01-01T00:00:00Z',
    write_date: '2024-01-01T00:00:00Z',
    ...overrides,
  } as Node;
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function lastPopupProps(): TriggerPopupProps {
  const calls = vi.mocked(TriggerPopup).mock.calls;
  return calls.at(-1)![0] as TriggerPopupProps;
}

describe('ClassPillsRow add-class button', () => {
  beforeEach(() => {
    useAuthStore.setState({ authVerified: true });
    vi.mocked(TriggerPopup).mockClear();
  });

  it('opens the shared TriggerPopup (same selector as the editor + trigger)', async () => {
    const applied = makeNode({ uuid: 'class-applied', name: 'Applied' });
    render(
      <TestWrapper>
        <ClassPillsRow classes={[applied]} nodeUuid="node-1" onAddClass={vi.fn()} parentIsCard />
      </TestWrapper>
    );

    expect(screen.queryByTestId('trigger-popup')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add class' }));
    // The popup is lazy-loaded to avoid a barrel-level import cycle.
    expect(await screen.findByTestId('trigger-popup')).toBeInTheDocument();

    const props = lastPopupProps();
    expect(props.type).toBe('class');
    expect(props.workspaceId).toBe('ws-test');
    expect(props.parentIsCard).toBe(true);
    // Already-applied classes are hidden from the selector.
    expect(props.excludeNodeIds).toEqual(['class-applied']);
  });

  it('assigns the selected class and closes the popup', async () => {
    const onAddClass = vi.fn();
    render(
      <TestWrapper>
        <ClassPillsRow classes={[]} nodeUuid="node-1" onAddClass={onAddClass} />
      </TestWrapper>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add class' }));
    await screen.findByTestId('trigger-popup');
    const props = lastPopupProps();

    act(() => {
      props.onSelectNode?.(makeNode({ uuid: 'class-new' }), 'default', false);
    });

    expect(onAddClass).toHaveBeenCalledWith('node-1', 'class-new');
    expect(screen.queryByTestId('trigger-popup')).not.toBeInTheDocument();
  });

  it('closes via onClose without assigning', async () => {
    const onAddClass = vi.fn();
    render(
      <TestWrapper>
        <ClassPillsRow classes={[]} nodeUuid="node-1" onAddClass={onAddClass} />
      </TestWrapper>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add class' }));
    await screen.findByTestId('trigger-popup');
    act(() => {
      lastPopupProps().onClose();
    });

    expect(onAddClass).not.toHaveBeenCalled();
    expect(screen.queryByTestId('trigger-popup')).not.toBeInTheDocument();
  });
});
