/**
 * WorkspaceModal Component
 * 
 * Modal for creating a new workspace.
 */
import { useState } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { createWorkspace, checkWorkspaceName, type WorkspaceInfo } from '@/api/workspaces';
import { AlertIcon, SyncIcon } from '../core/icons';
import Icon from '@mdi/react';
import { mdiCheck, mdiClose } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { TextField } from '../core/TextField';

interface WorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called when a workspace is successfully created */
  onSuccess?: (workspace: WorkspaceInfo) => void;
}

export function WorkspaceModal({ isOpen, onClose, onSuccess }: WorkspaceModalProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Debounced name check
  const { data: nameCheck, isLoading: isCheckingName } = useQuery({
    queryKey: ['workspace-name-check', name],
    queryFn: () => checkWorkspaceName(name),
    enabled: name.length >= 2,
    staleTime: 5000,
  });

  const createMutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: (newWorkspace) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      onSuccess?.(newWorkspace);
      handleClose();
    },
    onError: (err: Error) => {
      setError(err.message || 'Failed to create workspace');
    },
  });

  const handleClose = () => {
    setName('');
    setError(null);
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Please enter a workspace name');
      return;
    }

    if (name.trim().length < 2) {
      setError('Workspace name must be at least 2 characters');
      return;
    }

    createMutation.mutate(name.trim());
  };

  const isLoading = createMutation.isPending;
  const nameIsValid = name.length >= 2 && nameCheck?.available !== false;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Create New Workspace"
      size="sm"
      footer={
        <>
          <Button type="button" variant="default" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={isLoading || !nameIsValid}
            onClick={handleSubmit}
          >
            {isLoading ? 'Creating...' : 'Create Workspace'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <TextField
          label="Workspace Name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-notes"
          autoFocus
          error={name.length >= 2 && nameCheck?.available === false}
          errorMessage={name.length >= 2 && nameCheck?.available === false ? 'This name is already taken' : undefined}
          containerClassName={name.length >= 2 && nameCheck?.available && !isCheckingName ? 'text-field__container--valid' : ''}
          icon={
            isCheckingName ? (
              <SyncIcon size="xs" />
            ) : name.length >= 2 ? (
              <Icon path={nameCheck?.available ? mdiCheck : mdiClose} size={0.6} />
            ) : undefined
          }
        />

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', padding: 'var(--spacing-3)', background: 'var(--color-error-container)', borderRadius: 'var(--radius-sm)', color: 'var(--color-error)', fontSize: '0.875rem', marginTop: 'var(--spacing-3)' }}>
            <AlertIcon size="sm" /> {error}
          </div>
        )}
      </form>
    </Modal>
  );
}

export default WorkspaceModal;
