/**
 * AddPdfDialog — pick a PDF, extract identifiers, resolve metadata, confirm,
 * and create the source with the PDF attached (Library plugin, Task 14).
 *
 * Flow: pick file → inspect (extract DOI/ISBN/title backend-side + provider
 * lookup) → preview (resolved metadata, or a filename fallback when the PDF
 * has no identifiers) → confirm → the backend creates the source and
 * attaches the PDF as a `role=representation` asset; the dialog then pulls
 * the new ops (syncOnce), refreshes node queries, and hands the new node
 * uuid back via `onCreated` so the Library selects/opens it.
 *
 * Error states are explicit: unreadable PDF (400), extracted identifier has
 * no record (404), provider unreachable (502) — a failed inspect never
 * creates anything, and the create endpoint performs no network I/O, so
 * source/attachment state is always consistent (all-or-nothing backend-side).
 */
import { useCallback, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { TextField } from '@/components/ui/TextField';
import apiClient from '@/api/client';
import { queryClient } from '@/lib/queryClient';
import { nodeKeys } from '@/hooks/queryKeys';
import { getWorkspaceSyncEngine } from '@/core/adapters/workspaceStoreAdapter';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useNotificationStore } from '@/stores/notificationStore';
import { getApiErrorMessage } from '@/utils/apiError';
import { getLogger } from '@/utils/logger';
import { creatorDisplayName } from '../identifierLookup';
import {
  buildCreateFormData,
  buildInspectFormData,
  classifyPdfFlow,
  fieldsFromInspect,
  inspectErrorKind,
  isPdfFile,
  type CreateFromPdfResponse,
  type PdfInspectResponse,
  type PdfSourceFields,
} from '../pdfImport';
import './AddPdfDialog.css';

const log = getLogger('library-add-pdf');

const API_BASE = '/plugins/notees.library';

const PROVIDER_LABELS: Record<string, string> = {
  crossref: 'Crossref',
  openlibrary: 'Open Library',
};

export interface AddPdfDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the new source's uuid after a successful create. */
  onCreated: (nodeUuid: string) => void;
}

export function AddPdfDialog({ isOpen, onClose, onCreated }: AddPdfDialogProps) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<PdfInspectResponse | null>(null);
  const [fields, setFields] = useState<PdfSourceFields | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [creating, setCreating] = useState(false);

  const reset = useCallback(() => {
    setFile(null);
    setInspect(null);
    setFields(null);
    setError(null);
    setInspecting(false);
    setCreating(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleFilePicked = useCallback(async (picked: File) => {
    if (!isPdfFile(picked)) {
      setError('That file is not a PDF.');
      return;
    }
    setFile(picked);
    setInspecting(true);
    setError(null);
    try {
      const { data } = await apiClient.post<PdfInspectResponse>(
        `${API_BASE}/pdf/inspect`,
        buildInspectFormData(picked),
      );
      setInspect(data);
      setFields(fieldsFromInspect(data));
    } catch (err) {
      setFile(null);
      const kind = inspectErrorKind(err);
      if (kind === 'not_pdf') {
        setError(getApiErrorMessage(err, 'This PDF could not be read (corrupt or protected).'));
      } else if (kind === 'not_found') {
        setError(getApiErrorMessage(err, 'No record found for the identifier in this PDF.'));
      } else if (kind === 'unavailable') {
        setError(getApiErrorMessage(err, 'The metadata provider is unreachable. Try again later.'));
      } else {
        log.error('PDF inspect failed', err);
        setError(getApiErrorMessage(err, 'Could not read the PDF. Check your connection and try again.'));
      }
    } finally {
      setInspecting(false);
    }
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!file || !fields || !fields.title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { data } = await apiClient.post<CreateFromPdfResponse>(
        `${API_BASE}/sources/from-pdf`,
        buildCreateFormData(file, fields),
      );
      // The node was created backend-side: pull the new ops, then refresh.
      const syncEngine = workspaceUuid ? getWorkspaceSyncEngine(workspaceUuid) : null;
      try {
        await syncEngine?.syncOnce();
      } catch (syncError) {
        log.warn('Sync after source creation failed; auto-sync will catch up', syncError);
      }
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      const notify = useNotificationStore.getState();
      if (data.needs_metadata) {
        notify.success('Source added', 'No identifiers found — complete the details manually.');
      } else {
        notify.success('Source added', data.citekey ? `@${data.citekey}` : fields.title.trim());
      }
      const nodeUuid = data.node_uuid;
      handleClose();
      onCreated(nodeUuid);
    } catch (err) {
      log.error('Source creation from PDF failed', err);
      setError(getApiErrorMessage(err, 'Could not create the source. Please try again.'));
    } finally {
      setCreating(false);
    }
  }, [file, fields, workspaceUuid, handleClose, onCreated]);

  const handleBack = useCallback(() => {
    setFile(null);
    setInspect(null);
    setFields(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const flow = inspect ? classifyPdfFlow(inspect) : null;
  const creatorsText = fields?.creators.map(creatorDisplayName).filter(Boolean).join(', ');
  const metadata = inspect?.metadata ?? null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Add PDF"
      size="md"
      footer={
        fields ? (
          <>
            <Button variant="ghost" onClick={handleBack} disabled={creating}>
              Back
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleConfirm()}
              loading={creating}
              disabled={!fields.title.trim()}
            >
              Add to library
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="add-pdf">
        {!fields ? (
          <>
            <p className="add-pdf__intro">
              Pick a PDF — we look for a DOI or ISBN inside and fetch the metadata from Crossref or
              Open Library. Without identifiers, a minimal source is created from the filename.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="add-pdf__file-input"
              aria-label="PDF file"
              onChange={(event) => {
                const picked = event.target.files?.[0];
                if (picked) void handleFilePicked(picked);
              }}
            />
            {inspecting && <p className="add-pdf__progress">Reading the PDF…</p>}
          </>
        ) : (
          <div className="add-pdf__preview">
            {flow === 'fallback' && (
              <p className="add-pdf__fallback-note" role="note">
                No DOI or ISBN found in this PDF — a minimal source is created; complete the details
                manually.
              </p>
            )}
            <TextField
              label="Title"
              value={fields.title}
              onChange={(event) => setFields({ ...fields, title: event.target.value })}
            />
            <dl className="add-pdf__fields">
              <div className="add-pdf__field">
                <dt>Type</dt>
                <dd className="add-pdf__class">{fields.class_name}</dd>
              </div>
              {creatorsText && (
                <div className="add-pdf__field">
                  <dt>Authors</dt>
                  <dd>{creatorsText}</dd>
                </div>
              )}
              {fields.publication_date && (
                <div className="add-pdf__field">
                  <dt>Published</dt>
                  <dd>{fields.publication_date}</dd>
                </div>
              )}
              {fields.publisher && (
                <div className="add-pdf__field">
                  <dt>Publisher</dt>
                  <dd>{fields.publisher}</dd>
                </div>
              )}
              {fields.isbn && (
                <div className="add-pdf__field">
                  <dt>ISBN</dt>
                  <dd>{fields.isbn}</dd>
                </div>
              )}
              {fields.doi && (
                <div className="add-pdf__field">
                  <dt>DOI</dt>
                  <dd>{fields.doi}</dd>
                </div>
              )}
            </dl>
            {metadata && (
              <p className="add-pdf__provider">
                via {PROVIDER_LABELS[metadata.provider] ?? metadata.provider}
              </p>
            )}
            <Checkbox
              label="Attach the PDF to the source"
              checked={fields.attach}
              onChange={(event) => setFields({ ...fields, attach: event.target.checked })}
            />
          </div>
        )}
        {error && (
          <p className="add-pdf__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default AddPdfDialog;
