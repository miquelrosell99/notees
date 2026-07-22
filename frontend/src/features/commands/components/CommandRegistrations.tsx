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
import { useSyncStatusStore } from '@/features/sync/stores/syncStatusStore';
import { queryClient } from '@/lib/queryClient';
import {
  usePageClass,
  useClasses,
  useCreateNode,
  useResetNodeViews,
} from '@/features/content';
import { nodeViewKeys } from '@/features/content';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { useWorkspaceRole } from '@/features/workspace/hooks/useWorkspaceRole';
import {
  forceResyncWorkspace,
  resetWorkspaceStore,
} from '@/core/adapters/workspaceStoreAdapter';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { useState } from 'react';

export function CommandRegistrations() {
  const { pageClassUuid } = usePageClass();
  const { data: allClasses } = useClasses();
  const openNode = useNavigationStore((s) => s.openNode);
  const currentNodeUuid = useNavigationStore((s) => s.currentNodeUuid);
  const { notifyError, notifyWarning, notifySuccess } = useNotifyActions();
  const createNodeMutation = useCreateNode();
  const resetNodeViewsMutation = useResetNodeViews();
  const { activeWorkspace } = useWorkspaceRole();
  const [showResetConfirm, setShowResetConfirm] = useState(false);

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

  // Force a full re-sync of the active workspace from the relay.
  useCommand(
    COMMAND_IDS.FORCE_RESYNC,
    () => {
      const workspaceId = activeWorkspace?.uuid;
      if (!workspaceId) {
        notifyWarning('No workspace active', 'Open a workspace before forcing a re-sync.');
        return;
      }
      useSyncStatusStore.getState().setForceResyncWorkspaceId(workspaceId);
      forceResyncWorkspace(workspaceId)
        .then(() => {
          notifySuccess('Re-sync complete', 'Workspace has been re-synced from the server.');
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Please try again.';
          notifyError('Re-sync failed', message);
        })
        .finally(() => {
          useSyncStatusStore.getState().setForceResyncWorkspaceId(null);
        });
    },
    {
      label: 'Force workspace re-sync',
      icon: 'mdi mdi-cloud-sync-outline',
      palette: { category: 'tools', keywords: ['sync', 'refresh', 'reload'] },
    }
  );

  // Discard all local state for the active workspace and check out from the server.
  useCommand(
    COMMAND_IDS.RESET_LOCAL_STATE,
    () => {
      if (!activeWorkspace?.uuid) {
        notifyWarning('No workspace active', 'Open a workspace before resetting local state.');
        return;
      }
      setShowResetConfirm(true);
    },
    {
      label: 'Discard local state and check out from server',
      icon: 'mdi mdi-database-remove-outline',
      palette: { category: 'tools', keywords: ['reset', 'clear', 'local', 'checkout'] },
    }
  );

  return (
    <ConfirmationModal
      isOpen={showResetConfirm}
      title="Discard local state?"
      message="This will delete the local copy of this workspace and rebuild it from the server. Any offline changes that have not yet synced will be lost."
      secondaryMessage="Use this when local state looks corrupt or out of sync."
      confirmLabel="Discard and rebuild"
      cancelLabel="Cancel"
      variant="danger"
      onConfirm={async () => {
        const workspaceId = activeWorkspace?.uuid;
        if (!workspaceId) return;
        await resetWorkspaceStore(workspaceId);
        useSyncStatusStore.getState().bumpWorkspaceResetNonce();
        notifySuccess('Local state discarded', 'Rebuilding workspace from the server…');
        setShowResetConfirm(false);
      }}
      onCancel={() => setShowResetConfirm(false)}
    />
  );
}
