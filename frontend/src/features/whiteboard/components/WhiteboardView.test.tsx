/**
 * WhiteboardView tests — inline presentation (Decision 24).
 *
 * A block with the `whiteboard` class renders the same canvas component as a
 * bounded card inside the document flow: an expand affordance opens the full
 * view and the minimap is hidden. The standalone (page) presentation is
 * unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { UseWhiteboardReturn } from '@/features/whiteboard/hooks/useWhiteboard';
import { DEFAULT_WHITEBOARD_DATA } from '@/features/whiteboard/types/whiteboard';

const openNode = vi.fn();

const fakeWb = {
  data: { ...DEFAULT_WHITEBOARD_DATA },
  removeElements: vi.fn(),
} as unknown as UseWhiteboardReturn;

vi.mock('@/features/whiteboard/hooks/useWhiteboard', () => ({
  useWhiteboard: () => fakeWb,
}));

vi.mock('@/features/whiteboard/hooks/useWhiteboardSelectors', () => ({
  useWhiteboardViewSettings: () => ({
    gridVisible: false,
    gridSize: 20,
    minimapVisible: true,
  }),
}));

vi.mock('@/features/content', () => ({
  useCreateNode: () => ({ mutate: vi.fn() }),
  useDeleteNode: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/stores', () => ({
  useNavigationStore: (selector: (s: { openNode: typeof openNode }) => unknown) =>
    selector({ openNode }),
}));

vi.mock('@/features/editor', () => ({
  LinkEditModal: () => null,
}));

vi.mock('./WhiteboardCanvas', () => ({
  WhiteboardCanvas: () => <div data-testid="whiteboard-canvas" />,
}));

vi.mock('./WhiteboardToolbar', () => ({
  WhiteboardToolbar: () => <div data-testid="whiteboard-toolbar" />,
}));

vi.mock('./WhiteboardContextMenu', () => ({
  WhiteboardContextMenu: () => null,
}));

vi.mock('./WhiteboardMinimap', () => ({
  WhiteboardMinimap: () => <div data-testid="whiteboard-minimap" />,
}));

import { WhiteboardView } from './WhiteboardView';

describe('WhiteboardView inline presentation', () => {
  beforeEach(() => {
    openNode.mockClear();
  });

  it('renders a bounded inline card with an expand affordance and no minimap', () => {
    const { container } = render(<WhiteboardView nodeUuid="block-1" inline />);

    expect(container.querySelector('.whiteboard-view--inline')).not.toBeNull();
    expect(screen.getByTestId('whiteboard-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('whiteboard-toolbar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open full whiteboard/i })).toBeInTheDocument();
    // Minimap is hidden inline even when globally enabled.
    expect(screen.queryByTestId('whiteboard-minimap')).not.toBeInTheDocument();
  });

  it('expand affordance opens the same node in the full view', () => {
    render(<WhiteboardView nodeUuid="block-1" inline />);

    fireEvent.click(screen.getByRole('button', { name: /Open full whiteboard/i }));

    expect(openNode).toHaveBeenCalledWith('block-1');
  });

  it('standalone presentation keeps the minimap and has no expand button', () => {
    const { container } = render(<WhiteboardView nodeUuid="page-1" />);

    expect(container.querySelector('.whiteboard-view--inline')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open full whiteboard/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('whiteboard-minimap')).toBeInTheDocument();
  });
});
