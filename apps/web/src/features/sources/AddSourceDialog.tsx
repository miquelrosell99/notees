/**
 * AddSourceDialog — the add-source flow's dialog, STREAMLINED since the
 * 2026-11-02 direct-create ruling: ONE input accepting a DOI, ISBN, PMID,
 * ADS bibcode, arXiv id/URL, plain URL, or a PDF file, with the FETCH
 * button INLINE at the field — the action at its object: while no clean
 * fetch is in hand it is the PRIMARY button; once fetched it demotes to a
 * quiet re-fetch for edits and Create takes the lead. Fetch resolves the
 * input (or the picked PDF) and shows an inline PREVIEW of the resolved
 * record (title, authors, year, venue, the matched identifiers, the OA-PDF
 * note); **Create adds the source DIRECTLY** — the same flush pipeline the
 * create form runs (validation-before-writes, citation self-heal,
 * auto-citekey, CAS upload, one undo batch) via the shared
 * `flushClassedCreate`, no form in between; the app opens the new source.
 * Editing the input (or swapping the file) invalidates the fetch: Create
 * greys out again until a fresh Fetch. The resolved DOI/ISBN/PMID already
 * on a live source pauses Create for one click — "Already in your library"
 * with Open-existing / Create-anyway, never a silent duplicate. On failure
 * the error is inline and honest: nothing half-creates (the create only
 * ever runs on a fully resolved record), a 403 resolver_disabled points at
 * the Sources settings, a 422 no_identifier_found says the PDF carried no
 * DOI, and the "Add manually" escape hatch still opens the prefilled
 * QuickCreateModal (the manual path's edit-before-create stays).
 *
 * Routing by input shape (features/sources/resolver.ts): doi/isbn/arxiv/
 * pmid/ads → GET /api/resolve; a plain URL → POST /api/resolve/pdf?url=
 * (the owner's PDF flow — the bytes stay server-side; the record's
 * pdf:{url} becomes the source's URL, never a CAS upload); a picked file →
 * POST /api/resolve/pdf multipart, and THAT file uploads to CAS + links on
 * the created source (the caller holds the bytes — the attach is real).
 * Records with a DOI may also answer pdf:{url} from the server's Unpaywall
 * enrichment — the dialog shows the link in its PDF field as a removable
 * chip; a picked file always wins over the fetched link, and a link-only
 * intent keeps the honest create semantics: it lands on the source's URL
 * property (the server never downloads publisher bytes for you).
 *
 * The dialog composes the fleet Modal's footer + the fleet FileDropZone
 * exactly as the other first-class dialogs (QuickCreateModal,
 * AssetUploadModal): the actions ride the Modal footer slot, the PDF pick
 * rides the drop zone with the AssetUploadModal selected-file row (the
 * document icon + name + category chip + size).
 *
 * The create form (QuickCreateModal) remains the MANUAL path's surface —
 * flushClassedCreate is the one pipeline both paths run, so the citation
 * self-heal, the archived-class auto-enable (un-archive + create + property
 * writes in ONE undo batch), and the auto-citekey live in the one place.
 */

import { useEffect, useId, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { AnyClient } from "../modals/quickCreate.js";
import { readSourceSettings } from "../modals/quickCreate.js";
import { QuickCreateModal, type QuickCreatePrefill } from "../modals/QuickCreateModal.js";
import { CATEGORY_LABELS, categoryOf, formatSize } from "../modals/AssetUploadModal.js";
import { Modal } from "../../components/ui/kit/Modal.js";
import { Button } from "../../components/ui/kit/Button.js";
import { TextField } from "../../components/ui/kit/TextField.js";
import { FileDropZone } from "../../components/ui/kit/FileDropZone.js";
import { Icon } from "../../ui/Icon.js";
import {
  ResolverRequestError,
  resolvePdfFile,
  classifySourceInput,
  resolveSourceInput,
  type ResolvedSourceRecord,
} from "./resolver.js";
import {
  displayNameOf,
  findSourceByIdentifier,
  flushClassedCreate,
  stagedEntriesOfValues,
} from "../modals/quickCreate.js";
import "./AddSourceDialog.css";

export interface AddSourceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The workspace data surface the prefilled create composes through. */
  client: AnyClient;
  /** The sync server coordinates (the resolver routes' credential). */
  serverUrl: string;
  credential: string;
  /** A pasted identifier/link the caller already holds (the picker's
   *  paste-URL row opens the dialog with its query prefilled). */
  initialInput?: string | undefined;
  /** Called with the new source id once created (the app opens the page). */
  onCreated?: ((nodeId: string) => void) | undefined;
  /** Opens the duplicate warning's existing source (the app page-open). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}

interface PrefilledState {
  classId: string;
  prefill: QuickCreatePrefill;
}

interface FetchedState {
  record: ResolvedSourceRecord;
  pdfFile: File | null;
}

/** The record's own type picks the prefill class (the resolver knows the
 *  work's type better than any caller guess). */
function resolveClassId(record: ResolvedSourceRecord): string {
  return (
    SYSTEM_CLASS_UUIDS[record.classKey as keyof typeof SYSTEM_CLASS_UUIDS] ??
    SYSTEM_CLASS_UUIDS.book
  );
}

/** Map the unified record onto the modal's staged prefill (the pdf intent halves). */
function prefillOf(
  record: ResolvedSourceRecord,
  pdfFile: File | null,
  pdfUrlOverride: string | null,
): QuickCreatePrefill {
  const values: Record<string, string> = {};
  const seed = (name: keyof typeof SYSTEM_PROPERTY_UUIDS, value: string | undefined): void => {
    if (value !== undefined && value.trim() !== "") values[SYSTEM_PROPERTY_UUIDS[name]] = value;
  };
  seed("authors", record.authors.join("; "));
  seed("editors", record.editors.join("; "));
  if (record.year !== undefined) seed("publicationDate", String(record.year));
  seed("doi", record.doi ?? undefined);
  seed("isbn", record.isbn ?? undefined);
  seed("pmid", record.pmid ?? undefined);
  seed("pmcid", record.pmcid ?? undefined);
  // The URL-mode PDF's direct link is the honest full-text URL — it wins
  // over the provider's landing page (the user pasted the PDF link).
  // pdfUrlOverride is the OA chip's effective state: the fetched link when
  // shown, null when dismissed or absent — so a dismissed chip falls
  // through to the provider's own url, never the OA link.
  seed("url", pdfUrlOverride ?? record.url ?? undefined);
  seed("publisher", record.publisher ?? undefined);
  // The class's venue fields ride by pool property name (only names the
  // seed manifest knows map onto reserved schema ids; the modal's citation
  // self-heal authors the schemas + class-local bindings for them).
  for (const [name, value] of Object.entries(record.fields)) {
    const schemaId =
      SYSTEM_PROPERTY_UUIDS[name as keyof typeof SYSTEM_PROPERTY_UUIDS];
    if (schemaId !== undefined && value.trim() !== "") values[schemaId] = value;
  }
  return {
    title: record.title,
    values,
    pdf: pdfFile !== null ? { file: pdfFile, filename: pdfFile.name } : null,
  };
}

/** The preview card's author line: up to three names, then "et al". */
function authorLineOf(record: ResolvedSourceRecord): string {
  const shown = record.authors.slice(0, 3).join(", ");
  return record.authors.length > 3 ? `${shown}, et al` : shown;
}

export function AddSourceDialog({
  isOpen,
  onClose,
  client,
  serverUrl,
  credential,
  initialInput = "",
  onCreated = undefined,
  onOpenNode = undefined,
}: AddSourceDialogProps) {
  const [input, setInput] = useState(initialInput);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState<FetchedState | null>(null);
  const [oaDismissed, setOaDismissed] = useState(false);
  /** The manual path's prefilled form (the resolver path creates directly). */
  const [prefilled, setPrefilled] = useState<PrefilledState | null>(null);
  /** The resolved identifiers already live in the library (Create pauses). */
  const [duplicate, setDuplicate] = useState<ReturnType<typeof findSourceByIdentifier>>(null);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The "PDF file" section label's id — the drop zone's aria-labelledby. */
  const pdfLabelId = useId();

  // Reset each open; the picker's paste carries its query in.
  useEffect(() => {
    if (!isOpen) return;
    setInput(initialInput);
    setFile(null);
    setBusy(false);
    setError(null);
    setFetched(null);
    setOaDismissed(false);
    setPrefilled(null);
    setDuplicate(null);
    setCreating(false);
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [isOpen, initialInput]);

  const resolverEnabled = readSourceSettings(client).resolverEnabled;

  // The OA link shown in the PDF field: the fetched record's Unpaywall pdf
  // url, removable; a picked file supersedes it (the attach is real bytes).
  const fetchedPdfUrl =
    fetched !== null && !oaDismissed && file === null ? (fetched.record.pdf?.url ?? null) : null;

  const resolve = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // The local short-circuit: no fetch when the resolver is off — the
    // honest error + the manual path (the Add manually button stays enabled).
    if (!resolverEnabled) {
      setError(
        "The metadata resolver is turned off. Enable it in Workspace settings → Features → Sources, or add the source manually.",
      );
      setBusy(false);
      return;
    }
    try {
      if (file !== null) {
        const record = await resolvePdfFile(serverUrl, credential, file, file.name);
        setFetched({ record, pdfFile: file });
      } else {
        const record = await resolveSourceInput(serverUrl, credential, input);
        setFetched({ record, pdfFile: null });
      }
      setOaDismissed(false);
    } catch (caught) {
      if (caught instanceof ResolverRequestError && caught.code === "resolver_disabled") {
        setError(
          "The metadata resolver is turned off. Enable it in Workspace settings → Features → Sources.",
        );
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  // The manual path: a failed (or resolver-off) Add never dead-ends — the
  // error region offers "Add manually", landing in the same citation form
  // with a best-effort prefill from what was typed or picked.
  const manualPrefillOf = (raw: string, picked: File | null): PrefilledState => {
    const base: PrefilledState = {
      classId: SYSTEM_CLASS_UUIDS.book,
      prefill: {
        title: "",
        values: {},
        ...(picked !== null ? { pdf: { file: picked, filename: picked.name } } : {}),
      },
    };
    const classified = classifySourceInput(raw);
    if (classified === null) {
      return { ...base, prefill: { ...base.prefill, title: raw.trim() } };
    }
    switch (classified.kind) {
      case "doi":
        return {
          ...base,
          prefill: { ...base.prefill, values: { [SYSTEM_PROPERTY_UUIDS.doi]: classified.value } },
        };
      case "isbn":
        return {
          ...base,
          prefill: { ...base.prefill, values: { [SYSTEM_PROPERTY_UUIDS.isbn]: classified.value } },
        };
      case "pmid":
        return {
          ...base,
          prefill: { ...base.prefill, values: { [SYSTEM_PROPERTY_UUIDS.pmid]: classified.value } },
        };
      case "arxiv":
        return {
          ...base,
          prefill: {
            ...base.prefill,
            values: { [SYSTEM_PROPERTY_UUIDS.url]: `https://arxiv.org/abs/${classified.value}` },
          },
        };
      case "ads":
        // A bibcode has no source property — the manual form opens empty.
        return base;
      case "url":
        // The weblink convention: the URL is the title.
        return {
          classId: SYSTEM_CLASS_UUIDS.web_page,
          prefill: {
            ...base.prefill,
            title: raw.trim(),
            values: { [SYSTEM_PROPERTY_UUIDS.url]: classified.url },
          },
        };
    }
  };

  // Step two is the prefilled QuickCreateModal (same dialog stack: close
  // this shell first so the modal's overlay owns the surface).
  if (prefilled !== null) {
    return (
      <QuickCreateModal
        isOpen
        client={client}
        classId={prefilled.classId}
        prefill={prefilled.prefill}
        onClose={onClose}
        onCreated={(nodeId) => {
          onClose();
          onCreated?.(nodeId);
        }}
        onOpenExisting={onOpenNode}
      />
    );
  }

  // The resolver path creates the node DIRECTLY (the streamlining ruling:
  // paste → Fetch → review the preview → Create → the app opens the new
  // source). The prefilled QuickCreateModal stays only for the MANUAL path
  // ("Add manually"), where the user edits before anything writes.
  const createNow = async (allowDuplicate: boolean): Promise<void> => {
    if (fetched === null || creating) return;
    const record = fetched.record;
    const prefill = prefillOf(record, fetched.pdfFile, oaDismissed ? null : (record.pdf?.url ?? null));
    const classId = resolveClassId(record);
    // The "Already in your library" guard the create form used to own: the
    // resolved identifiers already live on a source → pause for one click
    // (open the existing, or create anyway), never a silent duplicate.
    if (!allowDuplicate) {
      const hit = findSourceByIdentifier(client, {
        doi: prefill.values[SYSTEM_PROPERTY_UUIDS.doi],
        isbn: prefill.values[SYSTEM_PROPERTY_UUIDS.isbn],
        pmid: prefill.values[SYSTEM_PROPERTY_UUIDS.pmid],
      });
      if (hit !== null) {
        setDuplicate(hit);
        return;
      }
    }
    setDuplicate(null);
    setCreating(true);
    setError(null);
    try {
      const result = await flushClassedCreate(client, {
        classId,
        title: prefill.title,
        entries: stagedEntriesOfValues(client, prefill.values),
        prefill,
      });
      if (!result.ok) {
        setError(result.error);
        setCreating(false);
        return;
      }
      onClose();
      onCreated?.(result.id);
    } catch {
      setError("Failed to create. Please try again.");
      setCreating(false);
    }
  };

  // The emphasis follows the flow: while no clean fetch is in hand, Fetch
  // IS the dialog's primary action (it leads, inline at the field); once a
  // fetch succeeded and the record is reviewable, Create takes the lead and
  // Fetch demotes to a quiet re-fetch for edits.
  const fetchIsPrimary = fetched === null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add source"
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy || creating}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void createNow(false)}
            disabled={busy || creating || fetched === null}
            loading={creating}
            title={fetched === null ? "Fetch first — Create adds the source to your library and opens it" : undefined}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="add-source-dialog">
        <p className="add-source-dialog__hint">
          Paste a DOI, ISBN, PMID, ADS bibcode, arXiv id or URL, a PDF link, or drop a PDF
          file — Fetch resolves the metadata and shows a preview; Create adds the source to
          your library and opens it.
        </p>
        <div className="add-source-dialog__fetch-row">
          <TextField
            ref={inputRef}
            label="Identifier or link"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setError(null);
              // Any edit invalidates the fetched preview — Fetch again.
              setFetched(null);
              setOaDismissed(false);
              setDuplicate(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void resolve();
            }}
            placeholder="10.… / 978-… / PMID / bibcode / arXiv:… / https://…"
            autoComplete="off"
            disabled={busy}
          />
          <Button
            variant={fetchIsPrimary ? "primary" : "outline"}
            onClick={() => void resolve()}
            disabled={busy || (input.trim() === "" && file === null)}
            loading={busy}
          >
            Fetch
          </Button>
        </div>
        {duplicate !== null && (
          <div className="add-source-dialog__duplicate" role="alert">
            <p className="add-source-dialog__duplicate-text">
              Already in your library:&nbsp;
              {onOpenNode !== undefined ? (
                <button
                  type="button"
                  className="add-source-dialog__duplicate-link"
                  onClick={() => {
                    onClose();
                    onOpenNode(duplicate.id);
                  }}
                >
                  {displayNameOf(duplicate) || "Untitled"}
                </button>
              ) : (
                <strong>{displayNameOf(duplicate) || "Untitled"}</strong>
              )}
              . Create it again anyway?
            </p>
            <div className="add-source-dialog__duplicate-actions">
              <Button variant="outline" size="sm" onClick={() => setDuplicate(null)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => void createNow(true)}>
                Create anyway
              </Button>
            </div>
          </div>
        )}
        {fetched !== null && (
          <div className="add-source-dialog__preview add-source-dialog__preview--card" role="status">
            <p className="add-source-dialog__preview-title">{fetched.record.title}</p>
            <p className="add-source-dialog__preview-meta">
              {[
                authorLineOf(fetched.record),
                fetched.record.year !== undefined ? String(fetched.record.year) : "",
                fetched.record.fields.publicationTitle ?? "",
              ]
                .filter((part) => part !== "")
                .join(" · ")}
            </p>
            <p className="add-source-dialog__preview-ids">
              {fetched.record.doi !== undefined && <span>DOI {fetched.record.doi}</span>}
              {fetched.record.isbn !== undefined && <span>ISBN {fetched.record.isbn}</span>}
              {fetched.record.pmid !== undefined && <span>PMID {fetched.record.pmid}</span>}
              {fetched.record.pmcid !== undefined && <span>PMCID {fetched.record.pmcid}</span>}
            </p>
          </div>
        )}
        <div className="add-source-dialog__field">
          <span id={pdfLabelId} className="add-source-dialog__section-label">PDF file</span>
          {fetchedPdfUrl !== null && (
            <div className="add-source-dialog__preview">
              <span className="add-source-dialog__doc-icon" aria-hidden="true">
                <Icon path="mdi-link-variant" size={1.6} />
              </span>
              <span className="add-source-dialog__meta">
                <span className="add-source-dialog__name">{fetchedPdfUrl}</span>
                <span className="add-source-dialog__sub">
                  <span className="add-source-dialog__chip">Open-access PDF</span>
                  links on the source — drop a file below to attach the file instead
                </span>
              </span>
              <button
                type="button"
                className="add-source-dialog__clear"
                onClick={() => setOaDismissed(true)}
                aria-label="Remove the fetched PDF link"
              >
                <Icon path="mdi-close" size={1} />
              </button>
            </div>
          )}
          <FileDropZone
            file={file}
            accept="application/pdf,.pdf"
            labelledBy={pdfLabelId}
            onSelect={(picked) => {
              setFile(picked);
              setError(null);
              // The file wins over the text input AND invalidates the fetch.
              setInput("");
              setFetched(null);
              setOaDismissed(false);
            }}
            onClear={() => {
              setFile(null);
              setFetched(null);
              setDuplicate(null);
            }}
            placeholder="Drop a PDF here"
            hint="or click to browse"
            icon={<Icon path="mdi-cloud-upload-outline" size={1.6} />}
            disabled={busy}
          />
          {file !== null && (
            <div className="add-source-dialog__preview">
              <span className="add-source-dialog__doc-icon" aria-hidden="true">
                <Icon path="mdi-file-outline" size={1.6} />
              </span>
              <span className="add-source-dialog__meta">
                <span className="add-source-dialog__name">{file.name}</span>
                <span className="add-source-dialog__sub">
                  <span className="add-source-dialog__chip">
                    {CATEGORY_LABELS[categoryOf(file)]}
                  </span>
                  {formatSize(file.size)}
                </span>
              </span>
            </div>
          )}
        </div>
        {!resolverEnabled && (
          <p className="add-source-dialog__note" role="status">
            The metadata resolver is turned off in Workspace settings → Features → Sources —
            Fetch still works, offering the manual form.
          </p>
        )}
        {error !== null && (
          <div className="add-source-dialog__error-row">
            <p role="alert" className="add-source-dialog__error">
              {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || (input.trim() === "" && file === null)}
              onClick={() => setPrefilled(manualPrefillOf(input, file))}
            >
              Add manually
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
