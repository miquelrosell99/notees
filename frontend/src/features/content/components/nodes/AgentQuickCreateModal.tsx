/**
 * AgentQuickCreateModal - Class-aware "create" dialog for agent-filtered
 * node pickers (Decision 19).
 *
 * Minimal agent creator: a type choice (person/organization, preselected by
 * the filter), given_name + family_name for persons (the display name is the
 * full natural name, feeding citekey generation), plain name for
 * organizations. Deliberately not a contact manager.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import type { Node } from '@/types';
import { createAgentNode, splitPersonName } from '../../utils/classAwareCreate';
import './QuickCreateModals.css';

type AgentType = 'person' | 'organization';

export interface AgentQuickCreateModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Initial name (the picker's search query that found no match) */
  initialName?: string;
  /** Preselected agent type (from the filtered class when unambiguous) */
  defaultAgentType?: AgentType;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback when the agent node was created */
  onCreated: (node: Node) => void;
}

export function AgentQuickCreateModal({
  isOpen,
  initialName = '',
  defaultAgentType = 'person',
  onClose,
  onCreated,
}: AgentQuickCreateModalProps) {
  const [agentType, setAgentType] = useState<AgentType>('person');
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  // Reset state each time the modal opens; split a free-typed person name
  // into given/family parts (last word = family name).
  useEffect(() => {
    if (isOpen) {
      setAgentType(defaultAgentType);
      const { givenName: given, familyName: family } = splitPersonName(initialName);
      setGivenName(given);
      setFamilyName(family);
      setOrgName(initialName.trim());
      setError(null);
      setIsCreating(false);
      setTimeout(() => firstFieldRef.current?.focus(), 100);
    }
  }, [isOpen, initialName, defaultAgentType]);

  const isValid = agentType === 'person'
    ? Boolean(givenName.trim() || familyName.trim())
    : Boolean(orgName.trim());

  const handleCreate = useCallback(async () => {
    if (!isValid) {
      setError(agentType === 'person' ? 'A given or family name is required.' : 'Name is required.');
      return;
    }
    if (!client) {
      setError('Workspace store is not ready.');
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const node = await createAgentNode(client, {
        agentType,
        name: orgName,
        givenName,
        familyName,
      });
      onCreated(node);
      onClose();
    } catch {
      setError('Failed to create agent. Please try again.');
      setIsCreating(false);
    }
  }, [agentType, orgName, givenName, familyName, isValid, client, onCreated, onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={agentType === 'person' ? 'New person' : 'New organization'}
      size="sm"
      footer={
        <>
          <Button variant="default" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleCreate} disabled={isCreating || !isValid}>
            {isCreating ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="quick-create-modal">
        <div className="quick-create-modal__field">
          <SelectionButton
            label="Type"
            options={[
              { value: 'person', label: 'Person', icon: 'mdi mdi-account-outline' },
              { value: 'organization', label: 'Organization', icon: 'mdi mdi-domain' },
            ]}
            value={agentType}
            onChange={(value) => setAgentType(value as AgentType)}
            size="sm"
          />
        </div>

        {agentType === 'person' ? (
          <>
            <div className="quick-create-modal__field">
              <TextField
                ref={firstFieldRef}
                label="Given name"
                value={givenName}
                onChange={(e) => { setGivenName(e.target.value); setError(null); }}
                placeholder="Frank"
                autoComplete="off"
              />
            </div>
            <div className="quick-create-modal__field">
              <TextField
                label="Family name"
                value={familyName}
                onChange={(e) => { setFamilyName(e.target.value); setError(null); }}
                placeholder="Herbert"
                autoComplete="off"
              />
            </div>
          </>
        ) : (
          <div className="quick-create-modal__field">
            <TextField
              ref={firstFieldRef}
              label="Name"
              value={orgName}
              onChange={(e) => { setOrgName(e.target.value); setError(null); }}
              placeholder="Organization name"
              autoComplete="off"
            />
          </div>
        )}

        {error && <p className="quick-create-modal__error">{error}</p>}
      </div>
    </Modal>
  );
}
