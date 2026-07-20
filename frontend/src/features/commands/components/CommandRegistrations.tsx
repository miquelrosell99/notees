/**
 * CommandRegistrations
 *
 * Registers commands whose handlers require React hooks or React Query context.
 * Rendering this component early in the app tree ensures these commands override
 * any static placeholder registrations before the command palette is first used.
 */
import { useCommand } from '@/hooks/useCommand';
import { COMMAND_IDS } from '@/stores/commandRegistry';
import { useNavigationStore } from '@/stores';
import { useNotifyActions } from '@/features/layout';
import { queryClient } from '@/lib/queryClient';
import {
  usePageClass,
  useClasses,
  useCreateNode,
  useResetNodeViews,
} from '@/features/content';
import { nodeViewKeys } from '@/features/content';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';

export function CommandRegistrations() {
  const { pageClassUuid } = usePageClass();
  const { data: allClasses } = useClasses();
  const openNode = useNavigationStore((s) => s.openNode);
  const currentNodeUuid = useNavigationStore((s) => s.currentNodeUuid);
  const { notifyError, notifyWarning, notifySuccess } = useNotifyActions();
  const createNodeMutation = useCreateNode();
  const resetNodeViewsMutation = useResetNodeViews();

  // Toggle page privacy — not modeled in the core store yet, so this is a no-op.
  useCommand(
    COMMAND_IDS.TOGGLE_PRIVATE,
    () => {
      notifyWarning('Privacy toggle not available', 'Page privacy is not yet supported in the local-first store.');
    },
    {
      label: 'Toggle page privacy',
      icon: 'mdi mdi-lock-outline',
      requiresPage: true,
      palette: { category: 'page' },
    }
  );

  // Reset views for current node
  useCommand(
    COMMAND_IDS.RESET_VIEWS,
    () => {
      if (!currentNodeUuid) return;
      resetNodeViewsMutation.mutate(currentNodeUuid, {
        onSuccess: () => {
          queryClient.removeQueries({ queryKey: nodeViewKeys.details() });
          queryClient.removeQueries({ queryKey: nodeViewKeys.queryResults() });
          queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(currentNodeUuid) });
          queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(currentNodeUuid) });
          notifySuccess('Views reset', 'All views for this node have been reset to defaults.');
        },
        onError: () => {
          notifyError('Failed to reset views', 'Please try again.');
        },
      });
    },
    {
      label: 'Reset views to defaults (current node)',
      icon: 'mdi mdi-database-refresh',
      requiresPage: true,
      devOnly: true,
      palette: { category: 'page' },
    }
  );

  // Capture task — needs pageClassUuid and taskClassUuid from hooks
  useCommand(
    COMMAND_IDS.CAPTURE_TASK,
    () => {
      if (!pageClassUuid) {
        notifyWarning('Setup incomplete', 'Page class not found. Please reload the app.');
        return;
      }
      const taskClassUuid = allClasses?.find((c) => c.uuid === SYSTEM_CLASS_UUIDS.task)?.uuid;
      if (!taskClassUuid) {
        notifyWarning('Setup incomplete', 'Task class not found. Please reload the app.');
        return;
      }
      createNodeMutation.mutate(
        {
          name: 'New Task',
          class_uuids: [pageClassUuid, taskClassUuid],
        },
        {
          onSuccess: (newNode) => {
            openNode(newNode.uuid);
          },
          onError: () => {
            notifyError('Failed to create task', 'Please try again.');
          },
        }
      );
    },
    {
      label: 'Capture task',
      icon: 'mdi mdi-plus-circle-outline',
      palette: { category: 'navigation', keywords: ['task', 'todo', 'capture'] },
    }
  );

  return null;
}
