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
import { useNotifyActions } from '@/features/layout/hooks/useNotificationSelectors';
import { queryClient } from '@/lib/queryClient';
import { updateNode, createNode } from '@/api/nodes';
import { resetNodeViews } from '@/api/nodeViews';
import { usePageClass, useClasses } from '@/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/features/content/hooks/useNodeViews';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';

export function CommandRegistrations() {
  const { pageClassId } = usePageClass();
  const { data: allClasses } = useClasses();
  const { openNode, currentNodeId } = useNavigationStore();
  const { notifyError, notifyWarning, notifySuccess } = useNotifyActions();

  // Toggle page privacy — needs queryClient and current node data
  useCommand(
    COMMAND_IDS.TOGGLE_PRIVATE,
    () => {
      if (!currentNodeId) return;
      const allDetails = queryClient.getQueriesData<{ is_private?: boolean }>({ queryKey: nodeKeys.details() });
      const currentNodeEntry = allDetails.find(([key]) => Array.isArray(key) && key[2] === currentNodeId);
      const currentNode = currentNodeEntry?.[1];
      if (currentNode) {
        updateNode(currentNodeId, { is_private: !currentNode.is_private })
          .then(() => {
            queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(currentNodeId) });
          })
          .catch(() => {
            notifyError('Failed to toggle privacy', 'Please try again.');
          });
      } else {
        notifyWarning('Cannot toggle privacy', 'Page data is not loaded. Please try again.');
      }
    },
    {
      label: 'Toggle page privacy',
      icon: 'mdi mdi-lock-outline',
      requiresPage: true,
      palette: { category: 'page' },
    }
  );

  // Reset views for current node — needs queryClient
  useCommand(
    COMMAND_IDS.RESET_VIEWS,
    () => {
      if (!currentNodeId) return;
      resetNodeViews(currentNodeId)
        .then(() => {
          queryClient.removeQueries({ queryKey: nodeViewKeys.details() });
          queryClient.removeQueries({ queryKey: nodeViewKeys.queryResults() });
          queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(currentNodeId) });
          queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(currentNodeId) });
          notifySuccess('Views reset', 'All views for this node have been reset to defaults.');
        })
        .catch(() => {
          notifyError('Failed to reset views', 'Please try again.');
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

  // Capture task — needs pageClassId and taskClassId from hooks
  useCommand(
    COMMAND_IDS.CAPTURE_TASK,
    () => {
      if (!pageClassId) {
        notifyWarning('Setup incomplete', 'Page class not found. Please reload the app.');
        return;
      }
      const taskClassId = allClasses?.find((c) => c.uuid === SYSTEM_CLASS_UUIDS.task)?.id;
      if (!taskClassId) {
        notifyWarning('Setup incomplete', 'Task class not found. Please reload the app.');
        return;
      }
      createNode({
        name: 'New Task',
        classes: [pageClassId, taskClassId],
      })
        .then((newNode) => {
          openNode(newNode.id);
        })
        .catch(() => {
          notifyError('Failed to create task', 'Please try again.');
        });
    },
    {
      label: 'Capture task',
      icon: 'mdi mdi-plus-circle-outline',
      palette: { category: 'navigation', keywords: ['task', 'todo', 'capture'] },
    }
  );

  return null;
}
