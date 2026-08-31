/**
 * AddByIdentifierDialog — paste an ISBN or DOI, preview the resolved
 * metadata, confirm to create the source (Library plugin, Task 13).
 *
 * Flow: input → (lookup, loading) → preview (title editable) → confirm →
 * the backend creates the source node; the dialog then pulls the new ops
 * (syncOnce), refreshes node queries, and hands the new node uuid back via
 * `onCreated` so the Library selects/opens it. Error states are explicit:
 * invalid identifier, not found, provider unreachable — and a failed lookup
 * never creates anything.
 */
import { useCallback, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import apiClient from '@/api/client';
import { queryClient } from '@/lib/queryClient';
import { nodeKeys } from '@/hooks/queryKeys';
import { getWorkspaceSyncEngine } from '@/core/adapters/workspaceStoreAdapter';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useNotificationStore } from '@/stores/notificationStore';
import { getApiErrorMessage } from '@/utils/apiError';
import { getLogger } from '@/utils/logger';
import {
  buildCreatePayload,
  classifyIdentifier,
  creatorDisplayName,
  lookupErrorKind,
  type LookupMetadata,
} from '../identifierLookup';
import './AddByIdentifierDialog.css';

const log = getLogger('library-add-by-identifier');

const API_BASE = '/plugins/notees.library';

const PROVIDER_LABELS: Record<string, string> = {
  crossref: 'Crossref',
  openlibrary: 'Open Library',
};

export interface AddByIdentifierDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the new source's uuid after a successful create. */
  onCreated: (nodeUuid: string) => void;
}

interface LookupResponse {
  metadata: LookupMetadata;
}

interface CreateSourceResponse {
  node_uuid: string;
  citekey: string | null;
}

export function AddByIdentifierDialog({ isOpen, onClose, onCreated }: AddByIdentifierDialogProps) {
  const workspaceUuid = useCurrentWorkspaceUuid();

  const [identifier, setIdentifier] = useState('');
  const [metadata, setMetadata] = useState<LookupMetadata | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const reset = useCallback(() => {
    setIdentifier('');
    setMetadata(null);
    setTitle('');
    setError(null);
    setLoading(false);
    setCreating(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleLookup = useCallback(async () => {
    const raw = identifier.trim();
    if (!raw) return;
    if (!classifyIdentifier(raw)) {
      setError("That doesn't look like a valid ISBN or DOI.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiClient.post<LookupResponse>(`${API_BASE}/lookup`, {
        identifier: raw,
      });
      setMetadata(data.metadata);
      setTitle(data.metadata.title);
    } catch (err) {
      const kind = lookupErrorKind(err);
      if (kind === 'invalid') {
        setError(getApiErrorMessage(err, "That doesn't look like a valid ISBN or DOI."));
      } else if (kind === 'not_found') {
        setError(getApiErrorMessage(err, 'No record found for this identifier.'));
      } else if (kind === 'unavailable') {
        setError(getApiErrorMessage(err, 'The metadata provider is unreachable. Try again later.'));
      } else {
        log.error('Identifier lookup failed', err);
        setError(getApiErrorMessage(err, 'Lookup failed. Check your connection and try again.'));
      }
    } finally {
      setLoading(false);
    }
  }, [identifier]);

  const handleConfirm = useCallback(async () => {
    if (!metadata || !title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { data } = await apiClient.post<CreateSourceResponse>(
        `${API_BASE}/sources`,
        buildCreatePayload(metadata, title),
      );
      // The node was created backend-side: pull the new ops, then refresh.
      const syncEngine = workspaceUuid ? getWorkspaceSyncEngine(workspaceUuid) : null;
      try {
        await syncEngine?.syncOnce();
      } catch (syncError) {
        log.warn('Sync after source creation failed; auto-sync will catch up', syncError);
      }
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      useNotificationStore
        .getState()
        .success('Source added', data.citekey ? `@${data.citekey}` : metadata.title);
      const nodeUuid = data.node_uuid;
      handleClose();
      onCreated(nodeUuid);
    } catch (err) {
      log.error('Source creation failed', err);
      setError(getApiErrorMessage(err, 'Could not create the source. Please try again.'));
    } finally {
      setCreating(false);
    }
  }, [metadata, title, workspaceUuid, handleClose, onCreated]);

  const handleBack = useCallback(() => {
    setMetadata(null);
    setError(null);
  }, []);

  const creatorsText = metadata?.creators.map(creatorDisplayName).filter(Boolean).join(', ');

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Add by identifier"
      size="md"
      footer={
        metadata ? (
          <>
            <Button variant="ghost" onClick={handleBack} disabled={creating}>
              Back
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleConfirm()}
              loading={creating}
              disabled={!title.trim()}
            >
              Add to library
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            onClick={() => void handleLookup()}
            loading={loading}
            disabled={!identifier.trim()}
          >
            Look up
          </Button>
        )
      }
    >
      <div className="add-identifier">
        {!metadata ? (
          <>
            <p className="add-identifier__intro">
              Paste an ISBN or DOI — metadata is fetched from Open Library or Crossref.
            </p>
            <TextField
              label="ISBN or DOI"
              placeholder="978-0-441-17271-9 or 10.1038/nature12373"
              value={identifier}
              onChange={(event) => {
                setIdentifier(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleLookup();
              }}
              error={!!error}
            />
          </>
        ) : (
          <div className="add-identifier__preview">
            <TextField
              label="Title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <dl className="add-identifier__fields">
              <div className="add-identifier__field">
                <dt>Type</dt>
                <dd className="add-identifier__class">{metadata.class_name}</dd>
              </div>
              {creatorsText && (
                <div className="add-identifier__field">
                  <dt>Authors</dt>
                  <dd>{creatorsText}</dd>
                </div>
              )}
              {metadata.publication_date && (
                <div className="add-identifier__field">
                  <dt>Published</dt>
                  <dd>{metadata.publication_date}</dd>
                </div>
              )}
              {metadata.publisher && (
                <div className="add-identifier__field">
                  <dt>Publisher</dt>
                  <dd>{metadata.publisher}</dd>
                </div>
              )}
              {metadata.isbn && (
                <div className="add-identifier__field">
                  <dt>ISBN</dt>
                  <dd>{metadata.isbn}</dd>
                </div>
              )}
              {metadata.doi && (
                <div className="add-identifier__field">
                  <dt>DOI</dt>
                  <dd>{metadata.doi}</dd>
                </div>
              )}
            </dl>
            <p className="add-identifier__provider">
              via {PROVIDER_LABELS[metadata.provider] ?? metadata.provider}
            </p>
          </div>
        )}
        {error && (
          <p className="add-identifier__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default AddByIdentifierDialog;
