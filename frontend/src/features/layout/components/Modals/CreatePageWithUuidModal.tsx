/**
 * CreatePageWithUuidModal - Create a node with a user-specified UUID
 *
 * Lets the user set the node name, a forced UUID, and choose whether to create
 * a page or a block. For blocks, a parent page is required.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { NodeSelector, useCreateNode } from '@/features/content';
import { getNodeUuidByServerId } from '@/features/content/hooks/useNodeMutations.utils';
import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import type { Node } from '@/types';
import { generateUUID } from '@/utils/uuid';
import './CreatePageWithUuidModal.css';

export interface CreatePageWithUuidModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback when the node is successfully created */
  onSuccess: (node: Node) => void;
  /** Optional UUID to pre-fill instead of generating a fresh one */
  prefillUuid?: string | null;
}

export function CreatePageWithUuidModal({
  isOpen,
  onClose,
  onSuccess,
  prefillUuid,
}: CreatePageWithUuidModalProps) {
  const [nodeName, setNodeName] = useState('');
  const [uuid, setUuid] = useState('');
  const [isPage, setIsPage] = useState(true);
  const [parentUuid, setParentUuid] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const createNodeMutation = useCreateNode();

  // Reset and generate a fresh UUID each time the modal opens
  useEffect(() => {
    if (isOpen) {
      setNodeName('');
        setUuid(prefillUuid ?? generateUUID());
        setIsPage(true);
        setParentUuid(null);
        setError(null);
        setIsCreating(false);;
      setTimeout(() => nameRef.current?.focus(), 100);
    }
  }, [isOpen, prefillUuid]);

  const isValidUuid = useCallback((value: string) => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
  }, []);

  const doCreate = useCallback(async (andOpen: boolean) => {
    const trimmedName = nodeName.trim();
    const trimmedUuid = uuid.trim();

    if (!trimmedName) {
      setError(`${isPage ? 'Page' : 'Block'} name is required.`);
      return;
    }
    if (!isValidUuid(trimmedUuid)) {
      setError('UUID must be a valid v4 UUID (e.g. 550e8400-e29b-41d4-a716-446655440000).');
      return;
    }
    if (!isPage && parentUuid == null) {
      setError('Parent page is required for blocks.');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // Check whether a node with this UUID already exists
      let exists = false;
      if (workspaceUuid) {
        const client = getWorkspaceStoreClient(workspaceUuid);
        if (client) {
          const existing = await client.query<Node | null>('getNodeByUuid', [trimmedUuid]);
          exists = existing !== null;
        }
      }

      if (exists) {
        setError(`A node with UUID "${trimmedUuid}" already exists.`);
        setIsCreating(false);
        return;
      }

      const payload: {
        name: string;
        uuid: string;
        kind?: 'page' | 'block';
        parent_uuid?: string | null;
      } = {
        name: trimmedName,
        uuid: trimmedUuid,
        kind: isPage ? 'page' : 'block',
      };

      if (!isPage) {
        payload.parent_uuid = parentUuid;
      }

      const newNode = await createNodeMutation.mutateAsync(payload);

      if (andOpen) {
        onSuccess(newNode);
      }
      onClose();
    } catch {
      setError(`Failed to create ${isPage ? 'page' : 'block'}. Please try again.`);
    } finally {
      setIsCreating(false);
    }
  }, [nodeName, uuid, isPage, parentUuid, isValidUuid, createNodeMutation, onSuccess, onClose, workspaceUuid]);

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
      title="Create node with custom UUID"
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
            disabled={isCreating || !nodeName.trim()}
          >
            Create
          </Button>
          <Button
            variant="primary"
            onClick={handleCreateAndOpen}
            size="sm"
            disabled={isCreating || !nodeName.trim()}
          >
            {isCreating ? 'Creating…' : 'Open'}
          </Button>
        </div>
      }
    >
      <div className="create-uuid-modal">
        {/* Page / Block toggle */}
        <div className="create-uuid-modal__field">
          <label htmlFor="cup-type" className="create-uuid-modal__label">Type</label>
          <ToggleSwitch
            id="cup-type"
            leftLabel="Page"
            rightLabel="Block"
            checked={!isPage}
            onChange={(checked) => {
              setIsPage(!checked);
              setError(null);
            }}
            size="md"
          />
        </div>

        <div className="create-uuid-modal__field">
          <label className="create-uuid-modal__label" htmlFor="cup-name">
            {isPage ? 'Page name' : 'Block name'}
          </label>
          <input
            ref={nameRef}
            id="cup-name"
            type="text"
            className="create-uuid-modal__input"
            value={nodeName}
            onChange={(e) => { setNodeName(e.target.value); setError(null); }}
            onKeyDown={handleKeyDown}
            placeholder={isPage ? 'My page' : 'My block'}
            autoComplete="off"
          />
        </div>

        {/* Parent page picker — shown only for blocks */}
        {!isPage && (
          <div className="create-uuid-modal__field">
            <label htmlFor="cup-parent" className="create-uuid-modal__label">
              Parent page
              <span className="create-uuid-modal__required"> *</span>
            </label>
            <NodeSelector
              id="cup-parent"
              trigger="select"
              searchMode="pages"
              multi={false}
              value={null}
              placeholder="Select a parent page…"
              searchPlaceholder="Search pages…"
              onChange={(val) => {
                if (val == null) {
                  setParentUuid(null);
                } else {
                  const selectedId = typeof val === 'number' ? val : val[0];
                  setParentUuid(getNodeUuidByServerId(queryClient, selectedId));
                }
                setError(null);
              }}
              allowCreate={false}
            />
          </div>
        )}

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
