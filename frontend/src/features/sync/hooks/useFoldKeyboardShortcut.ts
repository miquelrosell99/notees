/**
 * useFoldKeyboardShortcut — toggle fold state of the focused block.
 *
 * Fold state is local-only and stored in the ui_state store. It is never synced.
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
