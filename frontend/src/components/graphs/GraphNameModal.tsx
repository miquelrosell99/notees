/**
 * GraphNameModal Component
 * 
 * Reusable modal for entering a graph name. Used for both creating
 * new graphs and naming imported graphs.
 */
import { useState, useEffect } from 'react';
import './GraphModal.css';
import { useQuery } from '@tanstack/react-query';
import { checkDatabaseName } from '@/api/databases';
import { AlertIcon, SyncIcon } from '../icons';
import Icon from '@mdi/react';
import { mdiCheck, mdiClose } from '@mdi/js';
import { Button } from '../core/Button';

interface GraphNameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
  title: string;
  submitLabel: string;
  isLoading?: boolean;
  error?: string | null;
}

export function GraphNameModal({ 
  isOpen, 
  onClose, 
  onSubmit, 
  title, 
  submitLabel,
  isLoading = false,
  error: externalError = null,
}: GraphNameModalProps) {
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
      setError('Please enter a graph name');
      return;
    }

    if (name.trim().length < 2) {
      setError('Graph name must be at least 2 characters');
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
      <div className="graph-modal">
        <div className="graph-modal__header">
          <h2 className="graph-modal__title">{title}</h2>
          <Button icon={mdiClose} iconOnly className="graph-modal__close" onClick={handleClose} size="sm" variant="ghost" aria-label="Close dialog" />
        </div>

        <form className="graph-modal__form" onSubmit={handleSubmit}>
          <div className="graph-modal__field">
            <label className="graph-modal__label">Graph Name</label>
            <div className="graph-modal__input-wrapper">
              <input
                type="text"
                className={`graph-modal__input ${
                  name.length >= 2 
                    ? nameCheck?.available === false 
                      ? 'graph-modal__input--error' 
                      : 'graph-modal__input--valid'
                    : ''
                }`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-notes"
                autoFocus
              />
              {isCheckingName && (
                <span className="graph-modal__input-status graph-modal__input-status--loading">
                  <SyncIcon size="xs" />
                </span>
              )}
              {!isCheckingName && name.length >= 2 && (
                <span className={`graph-modal__input-status ${
                  nameCheck?.available 
                    ? 'graph-modal__input-status--valid' 
                    : 'graph-modal__input-status--error'
                }`}>
                  {nameCheck?.available 
                    ? <Icon path={mdiCheck} size={0.6} /> 
                    : <Icon path={mdiClose} size={0.6} />
                  }
                </span>
              )}
            </div>
            {name.length >= 2 && nameCheck?.available === false && (
              <p className="graph-modal__field-error">
                This name is already taken
              </p>
            )}
          </div>

          {error && (
            <div className="graph-modal__error">
              <AlertIcon size="sm" /> {error}
            </div>
          )}

          <div className="graph-modal__actions">
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
                  <span className="graph-modal__spinner" />
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

export default GraphNameModal;
