/**
 * CreatePageWithUuidModal - Create a page with a user-specified UUID
 *
 * Lets the user set both the page name and a forced UUID.
 * Validates that no node with the given UUID already exists before creating.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { useCreateNode, usePageClass } from '@/hooks';
import { getNodeByUuid } from '@/api/nodes';
import type { Node } from '@/types';
import { generateUUID } from '@/utils/uuid';
import './CreatePageWithUuidModal.css';

export interface CreatePageWithUuidModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback when the page is successfully created */
  onSuccess: (node: Node) => void;
}

export function CreatePageWithUuidModal({
  isOpen,
  onClose,
  onSuccess,
}: CreatePageWithUuidModalProps) {
  const [pageName, setPageName] = useState('');
  const [uuid, setUuid] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();

  // Reset and generate a fresh UUID each time the modal opens
  useEffect(() => {
    if (isOpen) {
      setPageName('');
      setUuid(generateUUID());
      setError(null);
      setIsCreating(false);
      setTimeout(() => nameRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const isValidUuid = useCallback((value: string) => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
  }, []);

  const doCreate = useCallback(async (andOpen: boolean) => {
    const trimmedName = pageName.trim();
    const trimmedUuid = uuid.trim();

    if (!trimmedName) {
      setError('Page name is required.');
      return;
    }
    if (!isValidUuid(trimmedUuid)) {
      setError('UUID must be a valid v4 UUID (e.g. 550e8400-e29b-41d4-a716-446655440000).');
      return;
    }
    if (!pageClassId) {
      setError('Page class not available. Please try again.');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // Check whether a node with this UUID already exists
      let exists = false;
      try {
        await getNodeByUuid(trimmedUuid);
        exists = true;
      } catch {
        // 404 means it does not exist — that's the happy path
      }

      if (exists) {
        setError(`A node with UUID "${trimmedUuid}" already exists.`);
        setIsCreating(false);
        return;
      }

      const newNode = await createNodeMutation.mutateAsync({
        name: trimmedName,
        uuid: trimmedUuid,
        classes: [pageClassId],
      });

      if (andOpen) {
        onSuccess(newNode);
      }
      onClose();
    } catch {
      setError('Failed to create page. Please try again.');
    } finally {
      setIsCreating(false);
    }
  }, [pageName, uuid, pageClassId, isValidUuid, createNodeMutation, onSuccess, onClose]);

  const handleCreate = useCallback(() => doCreate(false), [doCreate]);
  const handleCreateAndOpen = useCallback(() => doCreate(true), [doCreate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleCreateAndOpen();
      }
    },
    [handleCreateAndOpen],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create page with custom UUID"
      size="sm"
      footer={
        <div className="create-uuid-modal__footer">
          <Button variant="ghost" onClick={onClose} size="sm">
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleCreate}
            size="sm"
            disabled={isCreating || !pageName.trim()}
          >
            Create
          </Button>
          <Button
            variant="primary"
            onClick={handleCreateAndOpen}
            size="sm"
            disabled={isCreating || !pageName.trim()}
          >
            {isCreating ? 'Creating…' : 'Open'}
          </Button>
        </div>
      }
    >
      <div className="create-uuid-modal">
        <div className="create-uuid-modal__field">
          <label className="create-uuid-modal__label" htmlFor="cup-name">
            Page name
          </label>
          <input
            ref={nameRef}
            id="cup-name"
            type="text"
            className="create-uuid-modal__input"
            value={pageName}
            onChange={(e) => { setPageName(e.target.value); setError(null); }}
            onKeyDown={handleKeyDown}
            placeholder="My page"
            autoComplete="off"
          />
        </div>

        <div className="create-uuid-modal__field">
          <label className="create-uuid-modal__label" htmlFor="cup-uuid">
            UUID
          </label>
          <div className="create-uuid-modal__uuid-row">
            <input
              id="cup-uuid"
              type="text"
              className="create-uuid-modal__input create-uuid-modal__input--mono"
              value={uuid}
              onChange={(e) => { setUuid(e.target.value); setError(null); }}
              onKeyDown={handleKeyDown}
              placeholder="xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setUuid(generateUUID()); setError(null); }}
              title="Generate a new random UUID"
            >
              ↺
            </Button>
          </div>
        </div>

        {error && (
          <p className="create-uuid-modal__error">{error}</p>
        )}
      </div>
    </Modal>
  );
}

export default CreatePageWithUuidModal;
