/**
 * QuickCreateModal — the class-fields step of the create-first flow:
 * EVERY class picked from the quick-create flow leads here (after the node
 * was created and opened — createNodeWithClasses), with the properties form
 * loaded dynamically from the picked classes' bound properties
 * (stagedBindingsForClasses — the multi-class aggregate, extends-aware,
 * alphabetical). Values are STAGED in modal state and flushed to the op log
 * only on Save (flushClassedProperties — the node already exists; only the
 * class fields write). Cancel leaves the created node with its title — the
 * title is NOT staged here at all: the page's own title editor owns it
 * (title-is-content, full editor features at creation time).
 *
 * The citation-family behaviors key off every picked class's LINEAGE, not
 * hardcoded field sets: auto-citekey fills an empty staged citekey from the
 * settings pattern whenever the Sources feature is on (rendered against the
 * node's LIVE title — the page editor owns it), and a staged DOI, ISBN,
 * PMID, or CITEKEY already on a live source surfaces the "Already in your
 * library" warning — and an exact title match on ANOTHER live class member
 * (the just-created node itself excluded) surfaces the same non-blocking
 * warning with the open-existing affordance. The staged rows are pure reads
 * (the system-seed synthesis + the prefill's carried rows); the citation
 * schemas self-heal only at the Save flush (ensureCitationFamily), so
 * fresh/offline workspaces write the same rows a server-seeded one has.
 * The add-source flow (features/sources/AddSourceDialog) mounts it with a
 * resolver PREFILL (seeded staged values + the PDF attach intent).
 */

import { useEffect, useMemo, useState } from "react";

import {
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  type SystemClassName,
} from "@notees/domain";

import type {
  AnyClient,
  StagedPropertyBinding,
  StagedPropertyValue,
} from "./quickCreate.js";
import {
  anyCitationFamilyClass,
  citationDraftOf,
  classDisplayName,
  displayNameOf,
  findClassMemberByTitle,
  findSourceByIdentifier,
  flushClassedProperties,
  stagedBindingsForClasses,
  stagedPrefillRowsOf,
} from "./quickCreate.js";
import { StagedPropertiesForm } from "./StagedPropertiesForm.js";
import { Modal } from "../../components/ui/kit/Modal.js";
import { Button } from "../../components/ui/kit/Button.js";
import { Icon } from "../../ui/Icon.js";
import "./QuickCreateModal.css";

/**
 * The add-source resolver prefill: the unified metadata record mapped onto
 * the modal's staged form (text-shaped staged values keyed by property schema
 * id — authors/editors as monoblock text, the year as the staged date text)
 * plus the PDF attach intent (the multipart upload's File — uploaded to CAS
 * and linked on the node at the Save flush). `title` was consumed at the
 * create (the node already carries it); the form never stages a title.
 */
export interface QuickCreatePrefill {
  title: string;
  /** propertySchemaId → seed text (the text/number/date staged kinds). */
  values: Record<string, string>;
  /** The resolved-PDF attach intent (multipart mode). */
  pdf?: { file: Blob; filename: string } | null;
}

export interface QuickCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The workspace data surface the fields flush composes through. */
  client: AnyClient;
  /** The already-created node the class fields land on (create-first). */
  nodeId: string;
  /** The picked classes — FIXED for the modal's lifetime; the form
   *  aggregates the union of their bound properties. */
  classIds: string[];
  /** The add-source resolver prefill (seeded staged values + the PDF attach). */
  prefill?: QuickCreatePrefill | undefined;
  /** Called with the node id once the staged fields are flushed. */
  onDone?: ((nodeId: string) => void) | undefined;
  /** Opens the duplicate-warning's existing node (a link, when provided). */
  onOpenExisting?: ((nodeId: string) => void) | undefined;
}

/** The first class node's icon, or the system manifest icon for system classes. */
function classIconOf(client: AnyClient, classId: string): string | null {
  const node = client.listClasses().find((cls) => cls.id === classId);
  if (typeof node?.icon === "string" && node.icon !== "") return node.icon;
  const entry = (Object.entries(SYSTEM_CLASS_UUIDS) as Array<[string, string]>).find(
    ([, uuid]) => uuid === classId,
  );
  if (entry === undefined) return null;
  return SYSTEM_CLASS_ICONS[entry[0] as SystemClassName] ?? null;
}

export function QuickCreateModal({
  isOpen,
  onClose,
  client,
  nodeId,
  classIds,
  prefill = undefined,
  onDone,
  onOpenExisting = undefined,
}: QuickCreateModalProps) {
  /** User edits only — a row's rendered value is `values[id] ?? seedValue(row)`. */
  const [values, setValues] = useState<Record<string, StagedPropertyValue>>({});

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const citationFamily = anyCitationFamilyClass(client, classIds);

  // Reset state each time the modal opens; the staged rows are PURE READS
  // (the system-seed synthesis + the prefill's carried rows); the schemas/
  // bindings self-heal only at the Save flush.
  useEffect(() => {
    if (!isOpen) return;
    setValues({});
    setError(null);
    setIsSaving(false);
  }, [isOpen, nodeId, classIds, client, prefill]);

  // The classes' staged rows (the multi-class aggregate, extends-aware,
  // alphabetical) plus the rows a resolver prefill carries that no picked
  // class binds (venue fields).
  const baseRows = useMemo(
    () => (isOpen ? stagedBindingsForClasses(client, classIds) : []),
    [client, classIds, isOpen],
  );
  const rows = useMemo(
    () =>
      isOpen
        ? [...baseRows, ...stagedPrefillRowsOf(client, prefill ?? { values: {} }, baseRows)]
        : [],
    [client, isOpen, prefill, baseRows],
  );

  /** The rendered value for a row: the user's edit, the prefill seed, or empty. */
  const valueOf = (row: StagedPropertyBinding): StagedPropertyValue => {
    const edited = values[row.binding.propertySchemaId];
    if (edited !== undefined) return edited;
    const seed = prefill?.values[row.binding.propertySchemaId];
    const empty = emptyValueOf(row);
    if (seed === undefined) return empty;
    if (empty.kind === "text" || empty.kind === "number" || empty.kind === "date") {
      return { ...empty, text: seed };
    }
    return empty;
  };

  const entriesOf = (): Array<{ row: StagedPropertyBinding; value: StagedPropertyValue }> =>
    rows.map((row) => ({ row, value: valueOf(row) }));

  // The node's LIVE title — the page editor behind the modal owns it; the
  // form never stages a title (title-is-content, edited with the full editor).
  const liveTitle = displayNameOf(client.getNode?.(nodeId));
  const trimmedTitle = liveTitle.trim();
  const firstClassName = classIds.length > 0 ? classDisplayName(client, classIds[0]!) : "Node";

  // The duplicate warning: the staged (or auto-generated) DOI/ISBN/PMID/
  // citekey already on a live source. The draft re-derives per staged edit;
  // the family scan itself re-runs only when one of the identifiers
  // actually changes (the scan walks the source family).
  const draft = useMemo(
    () =>
      citationFamily && isOpen
        ? citationDraftOf(client, entriesOf(), liveTitle)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entriesOf derives from values/rows/prefill; liveTitle rides the same render.
    [citationFamily, isOpen, client, classIds, values, rows, prefill, nodeId],
  );
  const doiText = draft?.doi ?? "";
  const isbnText = draft?.isbn ?? "";
  const pmidText = draft?.pmid ?? "";
  const citekeyText = draft?.citekey ?? "";
  const duplicate = useMemo(
    () =>
      doiText === "" && isbnText === "" && pmidText === "" && citekeyText === ""
        ? null
        : findSourceByIdentifier(client, { doi: doiText, isbn: isbnText, pmid: pmidText, citekey: citekeyText }),
    [client, doiText, isbnText, pmidText, citekeyText],
  );
  // The exact-title duplicate: ANOTHER live member of any picked class whose
  // flattened title equals the node's live title (trim-only compare). The
  // just-created node itself is excluded (it is a member of the classes).
  // Re-checked as the form re-renders — the title lives on the page behind
  // the modal, so the check reads the freshest node row the render sees.
  const titleDuplicate = useMemo(() => {
    if (!isOpen || trimmedTitle === "") return null;
    for (const classId of classIds) {
      const hit = findClassMemberByTitle(client, classId, trimmedTitle, nodeId);
      if (hit !== null) return hit;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- classIds is fixed for the modal's lifetime; the deps the read actually answers to are the client/graph and the node's title (via re-render).
  }, [client, classIds, isOpen, trimmedTitle, nodeId]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const result = await flushClassedProperties(client, {
        nodeId,
        classIds,
        entries: entriesOf(),
        prefill,
      });
      if (!result.ok) {
        setError(result.error);
        setIsSaving(false);
        return;
      }
      onDone?.(nodeId);
      onClose();
    } catch {
      setError("Failed to save. Please try again.");
      setIsSaving(false);
    }
  };

  const icon = classIds.length > 0 ? classIconOf(client, classIds[0]!) : null;
  const headerTitle =
    classIds.length === 1
      ? `New ${firstClassName.toLowerCase()}`
      : classIds.length > 1
        ? "New item"
        : "New node";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={headerTitle}
      headerLeftElement={
        icon !== null ? <Icon path={icon} size={0.9} className="quick-create-modal__icon" /> : undefined
      }
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={isSaving} loading={isSaving}>
            Save
          </Button>
        </>
      }
    >
      <div className="quick-create-modal">
        <StagedPropertiesForm
          rows={rows}
          values={renderedValuesOf(rows, values, prefill)}
          onChange={(propertySchemaId, value) => {
            setValues((prev) => ({ ...prev, [propertySchemaId]: value }));
            setError(null);
          }}
        />
        {duplicate !== null && (
          <p className="quick-create-modal__warning" role="status">
            Already in your library:{" "}
            {onOpenExisting !== undefined ? (
              <button
                type="button"
                className="quick-create-modal__warning-link"
                onClick={() => onOpenExisting(duplicate.id)}
              >
                {displayNameOf(duplicate) || "Untitled"}
              </button>
            ) : (
              <strong>{displayNameOf(duplicate) || "Untitled"}</strong>
            )}
            .
          </p>
        )}
        {titleDuplicate !== null && (
          <p className="quick-create-modal__warning" role="status">
            A {firstClassName.toLowerCase()} titled &quot;{trimmedTitle}&quot; already exists:{" "}
            {onOpenExisting !== undefined ? (
              <button
                type="button"
                className="quick-create-modal__warning-link"
                onClick={() => onOpenExisting(titleDuplicate.id)}
              >
                {displayNameOf(titleDuplicate) || "Untitled"}
              </button>
            ) : (
              <strong>{displayNameOf(titleDuplicate) || "Untitled"}</strong>
            )}
            .
          </p>
        )}
        {error !== null && (
          <p role="alert" className="quick-create-modal__error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** The empty staged value for a row (module-local mirror of the initial shape). */
function emptyValueOf(row: StagedPropertyBinding): StagedPropertyValue {
  const type = row.schema?.type ?? row.binding.type;
  if (type === "boolean") return { kind: "boolean", value: null };
  if (type === "select" || type === "multi_select") return { kind: "select", optionIds: [] };
  if (type === "datetime") return { kind: "date", text: "" };
  if (type === "number") return { kind: "number", text: "" };
  return { kind: "text", text: "" };
}

/** The full rendered values record for the form (edits + prefill seeds + empty). */
function renderedValuesOf(
  rows: StagedPropertyBinding[],
  values: Record<string, StagedPropertyValue>,
  prefill: QuickCreatePrefill | undefined,
): Record<string, StagedPropertyValue> {
  const out: Record<string, StagedPropertyValue> = {};
  for (const row of rows) {
    const edited = values[row.binding.propertySchemaId];
    if (edited !== undefined) {
      out[row.binding.propertySchemaId] = edited;
      continue;
    }
    const empty = emptyValueOf(row);
    const seed = prefill?.values[row.binding.propertySchemaId];
    if (seed !== undefined && (empty.kind === "text" || empty.kind === "number" || empty.kind === "date")) {
      out[row.binding.propertySchemaId] = { ...empty, text: seed };
    } else {
      out[row.binding.propertySchemaId] = empty;
    }
  }
  return out;
}
