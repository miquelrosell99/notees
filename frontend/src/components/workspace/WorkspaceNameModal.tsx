/**
 * WorkspaceNameModal Component
 * 
 * Reusable modal for entering a workspace name. Used for both creating
 * new workspaces and naming imported workspaces.
 */
import { useState, useEffect } from 'react';
import './WorkspaceModal.css';
import { useQuery } from '@tanstack/react-query';
import { checkDatabaseName } from '@/api/databases';
import { AlertIcon, SyncIcon } from '../icons';
import Icon from '@mdi/react';
import { mdiCheck, mdiClose } from '@mdi/js';
import { Button } from '../core/Button';

interface WorkspaceNameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
  title: string;
  submitLabel: string;
  isLoading?: boolean;
  error?: string | null;
}

export function WorkspaceNameModal({ 
  isOpen, 
  onClose, 
  onSubmit, 
  title, 
  submitLabel,
  isLoading = false,
  error: externalError = null,
}: WorkspaceNameModalProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setName('');
      setError(null);
    }
  }, [isOpen]);

  // Sync external error
  useEffect(() => {
    setError(externalError);
  }, [externalError]);

  // Debounced name check
  const { data: nameCheck, isLoading: isCheckingName } = useQuery({
    queryKey: ['database-name-check', name],
    queryFn: () => checkDatabaseName(name),
    enabled: name.length >= 2,
    staleTime: 5000,
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

    if (nameCheck?.available === false) {
      setError('This name is already taken');
      return;
    }

    onSubmit(name.trim());
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  if (!isOpen) return null;

  const nameIsValid = name.length >= 2 && nameCheck?.available !== false;

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div className="workspace-modal">
        <div className="workspace-modal__header">
          <h2 className="workspace-modal__title">{title}</h2>
          <Button icon={mdiClose} iconOnly className="workspace-modal__close" onClick={handleClose} size="sm" variant="ghost" aria-label="Close dialog" />
        </div>

        <form className="workspace-modal__form" onSubmit={handleSubmit}>
          <div className="workspace-modal__field">
            <label className="workspace-modal__label">Workspace Name</label>
            <div className="workspace-modal__input-wrapper">
              <input
                type="text"
                className={`workspace-modal__input ${
                  name.length >= 2 
                    ? nameCheck?.available === false 
                      ? 'workspace-modal__input--error' 
                      : 'workspace-modal__input--valid'
                    : ''
                }`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-notes"
                autoFocus
              />
              {isCheckingName && (
                <span className="workspace-modal__input-status workspace-modal__input-status--loading">
                  <SyncIcon size="xs" />
                </span>
              )}
              {!isCheckingName && name.length >= 2 && (
                <span className={`workspace-modal__input-status ${
                  nameCheck?.available 
                    ? 'workspace-modal__input-status--valid' 
                    : 'workspace-modal__input-status--error'
                }`}>
                  {nameCheck?.available 
                    ? <Icon path={mdiCheck} size={0.6} /> 
                    : <Icon path={mdiClose} size={0.6} />
                  }
                </span>
              )}
            </div>
            {name.length >= 2 && nameCheck?.available === false && (
              <p className="workspace-modal__field-error">
                This name is already taken
              </p>
            )}
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
                  Processing...
                </>
              ) : (
                submitLabel
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default WorkspaceNameModal;
