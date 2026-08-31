/**
 * SourceQuickCreateModal - Class-aware "create" dialog for source-filtered
 * node pickers (Decision 17).
 *
 * Opens from the standard node-link picker when it is filtered by `source`
 * (or a source subclass) and no existing node matches. Creates a properly
 * classed source page with authors (agent refs), optional DOI and
 * publication year, then hands the node back to the picker to link/set.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { NodeSelector } from './NodeSelector';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import type { Node } from '@/types';
import {
  createSourceNode,
  sourceClassLabel,
  SOURCE_SUBCLASS_OPTIONS,
} from '../../utils/classAwareCreate';
import './QuickCreateModals.css';

export interface SourceQuickCreateModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Initial title (the picker's search query that found no match) */
  initialTitle?: string;
  /** Preselected source class (the filtered subclass when unambiguous) */
  defaultClassUuid?: string;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback when the source node was created */
  onCreated: (node: Node) => void;
}

export function SourceQuickCreateModal({
  isOpen,
  initialTitle = '',
  defaultClassUuid,
  onClose,
  onCreated,
}: SourceQuickCreateModalProps) {
  const [title, setTitle] = useState('');
  const [classUuid, setClassUuid] = useState<string>(SYSTEM_CLASS_UUIDS.book);
  const [authorUuids, setAuthorUuids] = useState<string[]>([]);
  const [year, setYear] = useState('');
  const [doi, setDoi] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  // Reset state each time the modal opens
  useEffect(() => {
    if (isOpen) {
      setTitle(initialTitle);
      setClassUuid(defaultClassUuid ?? SYSTEM_CLASS_UUIDS.book);
      setAuthorUuids([]);
      setYear('');
      setDoi('');
      setError(null);
      setIsCreating(false);
      setTimeout(() => titleRef.current?.focus(), 100);
    }
  }, [isOpen, initialTitle, defaultClassUuid]);

  const handleCreate = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('Title is required.');
      return;
    }
    const trimmedYear = year.trim();
    if (trimmedYear && !/^\d{4}$/.test(trimmedYear)) {
      setError('Publication year must be a 4-digit year (e.g. 1965).');
      return;
    }
    if (!client) {
      setError('Workspace store is not ready.');
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const node = await createSourceNode(client, {
        title: trimmedTitle,
        classUuid,
        authorUuids,
        doi: doi.trim() || undefined,
        publicationYear: trimmedYear ? parseInt(trimmedYear, 10) : null,
      });
      onCreated(node);
      onClose();
    } catch {
      setError('Failed to create source. Please try again.');
      setIsCreating(false);
    }
  }, [title, year, doi, classUuid, authorUuids, client, onCreated, onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`New ${sourceClassLabel(classUuid).toLowerCase()}`}
      size="md"
      footer={
        <>
          <Button variant="default" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={isCreating || !title.trim()}
          >
            {isCreating ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="quick-create-modal">
        <div className="quick-create-modal__field">
          <SelectionButton
            label="Type"
            options={SOURCE_SUBCLASS_OPTIONS}
            value={classUuid}
            onChange={setClassUuid}
            size="sm"
          />
        </div>

        <div className="quick-create-modal__field">
          <TextField
            ref={titleRef}
            label="Title"
            value={title}
            onChange={(e) => { setTitle(e.target.value); setError(null); }}
            placeholder="Source title"
            autoComplete="off"
          />
        </div>

        <div className="quick-create-modal__field">
          {/* Authors are agent nodes; the picker stays class-aware (person or
              organization, find-or-create on no-match). */}
          <span className="quick-create-modal__label" id="sqc-authors-label">Authors</span>
          <NodeSelector
            trigger="select"
            multi
            searchMode="pages"
            classFilters={[SYSTEM_CLASS_UUIDS.agent]}
            value={authorUuids}
            onChange={(value) => setAuthorUuids(Array.isArray(value) ? value : value ? [value] : [])}
            placeholder="Add author…"
            searchPlaceholder="Search or create agents…"
            aria-labelledby="sqc-authors-label"
          />
        </div>

        <div className="quick-create-modal__row">
          <TextField
            label="Publication year"
            value={year}
            onChange={(e) => { setYear(e.target.value); setError(null); }}
            placeholder="1965"
            inputMode="numeric"
            autoComplete="off"
            wrapperClassName="quick-create-modal__year"
          />
          <TextField
            label="DOI"
            value={doi}
            onChange={(e) => { setDoi(e.target.value); setError(null); }}
            placeholder="10.1000/xyz123"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {error && <p className="quick-create-modal__error">{error}</p>}
      </div>
    </Modal>
  );
}
