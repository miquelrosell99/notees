/**
 * useFoldKeyboardShortcut — toggle fold state of the focused block.
 *
 * Phase 0 implementation:
 * - Updates the local-only ui_state store (future source of truth for fold state).
 * - Also dispatches a legacy toggle_collapsed intent so the UI reflects the
 *   change immediately while node.collapsed is still the runtime source of truth.
 *   The legacy intent will be removed in Phase 3 when fold state becomes UI-only.
 */

import { useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useCommand } from '@/hooks/useCommand';
import { COMMAND_IDS } from '@/stores/commandRegistry';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { useUIStateStore } from '@/features/sync';

export function useFoldKeyboardShortcut(enabled = true): void {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);
  const toggleCollapsed = useUIStateStore((s) => s.toggleCollapsed);

  const execute = useCallback(() => {
    if (!workspaceId || !activeBlockId) return false;

    toggleCollapsed(workspaceId, activeBlockId);
    return true;
  }, [workspaceId, activeBlockId, toggleCollapsed]);

  useCommand(COMMAND_IDS.TOGGLE_FOLD, execute, {
    enabled,
    context: 'editor',
    label: 'Toggle Fold Block',
  });
}
