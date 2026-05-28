/**
 * WorkspaceNameModal Component
 * 
 * Reusable modal for entering a workspace name. Used for both creating
 * new workspaces and naming imported workspaces.
 */
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { checkWorkspaceName } from '@/api/workspaces';
import { Icon, AlertIcon, SyncIcon } from '@/components/core/icons';

import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { TextField } from '@/components/core/TextField';

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
        setError(null);;
    }
  }, [isOpen]);

  // Sync external error
  useEffect(() => {
    setError(externalError);
  }, [externalError]);

  // Debounced name check
  const { data: nameCheck, isLoading: isCheckingName } = useQuery({
    queryKey: ['workspace-name-check', name],
    queryFn: () => checkWorkspaceName(name),
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

  const nameIsValid = name.length >= 2 && nameCheck?.available !== false;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={title}
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
            {isLoading ? 'Processing...' : submitLabel}
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
              <Icon path={nameCheck?.available ? "mdi mdi-check" : "mdi mdi-close"} size={0.6} />
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

