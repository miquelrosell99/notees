/**
 * WorkspaceModal Component
 * 
 * Modal for creating a new workspace.
 */
import { useState } from 'react';
import './WorkspaceModal.css';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { createDatabase, checkDatabaseName, type DatabaseInfo } from '@/api/databases';
import { AlertIcon, SyncIcon } from '../core/icons';
import Icon from '@mdi/react';
import { mdiCheck, mdiClose } from '@mdi/js';
import { Button } from '../core/Button';
import { TextField } from '../core/TextField';

interface WorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called when a workspace is successfully created */
  onSuccess?: (workspace: DatabaseInfo) => void;
}

export function WorkspaceModal({ isOpen, onClose, onSuccess }: WorkspaceModalProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Debounced name check
  const { data: nameCheck, isLoading: isCheckingName } = useQuery({
    queryKey: ['database-name-check', name],
    queryFn: () => checkDatabaseName(name),
    enabled: name.length >= 2,
    staleTime: 5000,
  });

  const createMutation = useMutation({
    mutationFn: createDatabase,
    onSuccess: (newWorkspace) => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
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

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  if (!isOpen) return null;

  const isLoading = createMutation.isPending;
  const nameIsValid = name.length >= 2 && nameCheck?.available !== false;

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div className="workspace-modal">
        <div className="workspace-modal__header">
          <h2 className="workspace-modal__title">Create New Workspace</h2>
          <Button icon={mdiClose} iconOnly className="workspace-modal__close" onClick={handleClose} size="sm" variant="ghost" aria-label="Close dialog" />
        </div>

        <form className="workspace-modal__form" onSubmit={handleSubmit}>
          <div className="workspace-modal__field">
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
                  <span className="workspace-modal__input-status--loading">
                    <SyncIcon size="xs" />
                  </span>
                ) : name.length >= 2 ? (
                  <span
                    className={nameCheck?.available ? 'workspace-modal__input-status--valid' : 'workspace-modal__input-status--error'}
                  >
                    <Icon path={nameCheck?.available ? mdiCheck : mdiClose} size={0.6} />
                  </span>
                ) : undefined
              }
            />
          </div>

          {error && (
            <div className="workspace-modal__error">
              <AlertIcon size="sm" /> {error}
            </div>
          )}

          <div className="workspace-modal__actions">
            <Button
              type="button"
              variant="default"
              onClick={handleClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={isLoading || !nameIsValid}
            >
              {isLoading ? (
                <>
                  <span className="workspace-modal__spinner" />
                  Creating...
                </>
              ) : (
'Create Workspace'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default WorkspaceModal;
