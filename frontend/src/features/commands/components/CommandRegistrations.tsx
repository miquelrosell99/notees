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
import { useSyncStatusStore } from '@/features/sync';
import { queryClient } from '@/lib/queryClient';
import {
  useClasses,
  useCreateNode,
  useResetNodeViews,
} from '@/features/content';
import { nodeViewKeys } from '@/features/content';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { useWorkspaceRole } from '@/features/workspace';
import { useCapabilities } from '@/config/capabilities';
import {
  pushActiveWorkspace,
  pullActiveWorkspace,
} from '@/core/adapters/workspaceStoreClientAdapter';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { useState } from 'react';

export function CommandRegistrations() {
  const { data: allClasses } = useClasses();
  const openNode = useNavigationStore((s) => s.openNode);
  const currentNodeUuid = useNavigationStore((s) => s.currentNodeUuid);
  const { notifyError, notifyWarning, notifySuccess } = useNotifyActions();
  const createNodeMutation = useCreateNode();
  const resetNodeViewsMutation = useResetNodeViews();
  const { activeWorkspace } = useWorkspaceRole();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const capabilities = useCapabilities();

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

  // Capture task — needs taskClassUuid from hooks
  useCommand(
    COMMAND_IDS.CAPTURE_TASK,
    () => {
      const taskClassUuid = allClasses?.find((c) => c.uuid === SYSTEM_CLASS_UUIDS.task)?.uuid;
      if (!taskClassUuid) {
        notifyWarning('Setup incomplete', 'Task class not found. Please reload the app.');
        return;
      }
      createNodeMutation.mutate(
        {
          name: 'New Task',
          kind: 'page',
          class_uuids: [taskClassUuid],
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

  // Push any pending local operations to the server without pulling.
  useCommand(
    COMMAND_IDS.PUSH_TO_SERVER,
    () => {
      if (!activeWorkspace?.uuid) {
        notifyWarning('No workspace active', 'Open a workspace before pushing.');
        return;
      }
      pushActiveWorkspace()
        .then(() => {
          notifySuccess('Push complete', 'Local changes have been pushed to the server.');
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Please try again.';
          notifyError('Push failed', message);
        });
    },
    {
      label: 'Push local changes to server',
      icon: 'mdi mdi-cloud-upload-outline',
      palette: { category: 'tools', keywords: ['sync', 'push', 'upload'] },
      // Server sync is meaningless in local mode (local-first split, Task 4).
      enabled: capabilities.workspaceManagement,
    }
  );

  // Pull the active workspace down from the server, discarding local derived state.
  useCommand(
    COMMAND_IDS.PULL_FROM_SERVER,
    () => {
      if (!activeWorkspace?.uuid) {
        notifyWarning('No workspace active', 'Open a workspace before pulling.');
        return;
      }
      setShowResetConfirm(true);
    },
    {
      label: 'Pull from server (replace local copy)',
      icon: 'mdi mdi-cloud-download-outline',
      palette: { category: 'tools', keywords: ['sync', 'pull', 'reset', 'local'] },
      enabled: capabilities.workspaceManagement,
    }
  );

  return (
    <ConfirmationModal
      isOpen={showResetConfirm}
      title="Discard local state?"
      message="This will delete the local copy of this workspace and rebuild it from the server. Any offline changes that have not yet synced will be lost."
      secondaryMessage="Use this when local state looks corrupt or out of sync."
      confirmLabel="Replace local copy"
      cancelLabel="Cancel"
      variant="danger"
      onConfirm={async () => {
        const workspaceId = activeWorkspace?.uuid;
        if (!workspaceId) return;
        await pullActiveWorkspace();
        useSyncStatusStore.getState().bumpWorkspaceResetNonce();
        notifySuccess('Local state replaced', 'Rebuilding workspace from the server…');
        setShowResetConfirm(false);
      }}
      onCancel={() => setShowResetConfirm(false)}
    />
  );
}
