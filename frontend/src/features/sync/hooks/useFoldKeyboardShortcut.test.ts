import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFoldKeyboardShortcut } from './useFoldKeyboardShortcut';
import { useUIStateStore } from '../stores/uiStateStore';

const registeredCommands = new Map<string, () => boolean | void>();

vi.mock('@/hooks/useCommand', () => ({
  useCommand: (id: string, execute: () => boolean | void) => {
    registeredCommands.set(id, execute);
  },
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('@/stores/editorFocusStore', () => {
  const mockFocusState = { activeBlockId: 'block-1' };
  const fn = (selector: (s: { activeBlockId: string | null }) => unknown) => selector(mockFocusState);
  (fn as unknown as { getState: () => typeof mockFocusState }).getState = () => mockFocusState;
  return { useEditorFocusStore: fn };
});

describe('useFoldKeyboardShortcut', () => {
  beforeEach(() => {
    registeredCommands.clear();
    useUIStateStore.setState({ states: {} });
  });

  it('toggles uiStateStore for the active block', () => {
    renderHook(() => useFoldKeyboardShortcut());
    const execute = registeredCommands.get('ui.toggleFold');
    expect(execute).toBeDefined();

    execute?.();
    expect(useUIStateStore.getState().getNodeUIState('ws-1', 'block-1')?.collapsed).toBe(true);

    execute?.();
    expect(useUIStateStore.getState().getNodeUIState('ws-1', 'block-1')?.collapsed).toBe(false);
  });
});
