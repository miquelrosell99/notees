/**
 * WorkspaceModal Component
 *
 * Modal for creating a new workspace.
 * Composes WorkspaceNameModal with the create workspace mutation.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createWorkspace, type WorkspaceInfo } from '@/features/workspace/api/workspaces';
import { WorkspaceNameModal } from './WorkspaceNameModal';
import { workspaceKeys } from '@/hooks/queryKeys';


interface WorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called when a workspace is successfully created */
  onSuccess?: (workspace: WorkspaceInfo) => void;
}

export function WorkspaceModal({ isOpen, onClose, onSuccess }: WorkspaceModalProps) {
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: (newWorkspace) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
      onSuccess?.(newWorkspace);
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message || 'Failed to create workspace');
    },
  });

  const handleSubmit = (name: string) => {
    setError(null);
    createMutation.mutate(name);
  };

  const handleClose = () => {
    setError(null);
    onClose();
  };

  return (
    <WorkspaceNameModal
      isOpen={isOpen}
      onClose={handleClose}
      onSubmit={handleSubmit}
      title="Create New Workspace"
      submitLabel="Create Workspace"
      isLoading={createMutation.isPending}
      error={error}
    />
  );
}
