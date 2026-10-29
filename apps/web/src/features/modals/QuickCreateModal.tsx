/**
 * QuickCreateModal — the class-driven create dialog:
 * EVERY class picked from the quick-create flow opens it, with the
 * properties form loaded dynamically from the class's bound properties
 * (StagedPropertiesForm — extends-aware, alphabetical). Values are STAGED in
 * modal state and flushed to the op log only on Create — cancel leaves zero
 * log entries. The class id is FIXED for the modal's lifetime: the retired
 * source subclass switch and the agent person/organization toggle are gone
 * (the class pick replaces them).
 *
 * The citation-family behaviors key off the class LINEAGE, not hardcoded
 * field sets: auto-citekey fills an empty staged citekey from the settings
 * pattern whenever the Sources feature is on (no generation toggle — the
 * owner ruling 2026-10-29), and a staged DOI, ISBN, or CITEKEY already on a
 * live source surfaces the
 * "Already in your library" warning (citekey coverage added 2026-10-26) —
 * and an exact title match (a live class member whose flattened title equals
 * the staged title, trim-only compare) surfaces the same non-blocking
 * warning with the open-existing affordance — the create stays allowed
 * (explicit override), the warning is honest. The staged rows are pure reads (the system-seed synthesis + the prefill's
 * carried rows), so opening the modal — and cancelling it — leaves ZERO log
 * entries; the citation schemas self-heal only at the Create flush
 * (ensureCitationFamily), so fresh/offline workspaces write the same rows a
 * server-seeded one has. The add-source flow (features/sources/AddSourceDialog)
 * mounts it with a resolver PREFILL (seeded staged values + the PDF attach
 * intent). An archived picked class is auto-enabled at create — the
 * un-archive rides the SAME undo batch as the create and the property
 * writes (client.beginClassedCreate).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  type SystemClassName,
} from "@notees/domain";

import type {
  AnyClient,
  StagedPropertyBinding,
  StagedPropertyValue,
} from "./quickCreate.js";
import {
  citationDraftOf,
  classDisplayName,
  createClassedObject,
  displayNameOf,
  ensureCitationFamily,
  findClassMemberByTitle,
  findSourceByIdentifier,
  isArchivedClass,
  isCitationFamilyClass,
  parseStagedDateText,
  stagedBindingsOf,
  stagedPrefillRowsOf,
  stagedTextOf,
  systemClassLabel,
  venueKeysOfPrefill,
} from "./quickCreate.js";
import { StagedPropertiesForm } from "./StagedPropertiesForm.js";
import { Modal } from "../../components/ui/kit/Modal.js";
import { Button } from "../../components/ui/kit/Button.js";
import { TextField } from "../../components/ui/kit/TextField.js";
import { Icon } from "../../ui/Icon.js";
import "./QuickCreateModal.css";

/**
 * The add-source resolver prefill: the unified metadata record mapped onto
 * the modal's staged form (text-shaped staged values keyed by property schema
 * id — authors/editors as monoblock text, the year as the staged date text)
 * plus the PDF attach intent (the multipart upload's File — uploaded to CAS
 * and linked on the created node).
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
  /** The workspace data surface the create composes through. */
  client: AnyClient;
  /** The picked class — FIXED for the modal's lifetime (no subclass switch). */
  classId: string;
  /** The picker's search query that found no match — seeds the title. */
  initialName?: string | undefined;
  /** The add-source resolver prefill (seeded staged values + the PDF attach). */
  prefill?: QuickCreatePrefill | undefined;
  /** Called with the new node id once created (the picker links it). */
  onCreated: (nodeId: string) => void;
  /** Opens the duplicate-warning's existing node (a link, when provided). */
  onOpenExisting?: ((nodeId: string) => void) | undefined;
}

/** The class node's icon, or the system manifest icon for system classes. */
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
  classId,
  initialName = "",
  prefill = undefined,
  onCreated,
  onOpenExisting = undefined,
}: QuickCreateModalProps) {
  const [title, setTitle] = useState("");
  /** User edits only — a row's rendered value is `values[id] ?? seedValue(row)`. */
  const [values, setValues] = useState<Record<string, StagedPropertyValue>>({});

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const citationFamily = isCitationFamilyClass(client, classId);

  // Reset state each time the modal opens; a resolver prefill (the
  // add-source flow) wins over the picker's typed name. The staged rows are
  // PURE READS (the system-seed synthesis + the prefill's carried rows), so
  // opening the modal — and cancelling it — leaves ZERO log entries; the
  // schemas/bindings self-heal only at the Create flush.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(prefill?.title ?? initialName);
    setValues({});
    setError(null);
    setIsCreating(false);
    const timer = setTimeout(() => firstFieldRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [isOpen, initialName, classId, client, prefill]);

  // The class's staged rows (extends-aware, alphabetical) plus the rows a
  // resolver prefill carries that the class does not bind (venue fields).
  const rows = useMemo(
    () =>
      isOpen
        ? [
            ...stagedBindingsOf(client, classId),
            ...stagedPrefillRowsOf(client, prefill ?? { values: {} }, stagedBindingsOf(client, classId)),
          ]
        : [],
    [client, classId, isOpen, prefill],
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

  // The duplicate warning: the staged (or auto-generated) DOI/ISBN/citekey
  // already on a live source. The draft re-derives per staged edit; the
  // family scan itself re-runs only when one of the three identifiers
  // actually changes (the scan walks the source family).
  const draft = useMemo(
    () =>
      citationFamily && isOpen
        ? citationDraftOf(client, entriesOf(), title.trim())
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entriesOf derives from values/rows/prefill.
    [citationFamily, isOpen, client, classId, title, values, rows, prefill],
  );
  const doiText = draft?.doi ?? "";
  const isbnText = draft?.isbn ?? "";
  const citekeyText = draft?.citekey ?? "";
  const duplicate = useMemo(
    () =>
      doiText === "" && isbnText === "" && citekeyText === ""
        ? null
        : findSourceByIdentifier(client, { doi: doiText, isbn: isbnText, citekey: citekeyText }),
    [client, doiText, isbnText, citekeyText],
  );
  // The exact-title duplicate: a live class member whose
  // flattened title equals the staged title exactly (trimmed, case-sensitive).
  // Re-checked as the title field changes — same non-blocking mechanics as
  // the identifier duplicates.
  const trimmedTitle = title.trim();
  const titleDuplicate = useMemo(
    () => (isOpen ? findClassMemberByTitle(client, classId, trimmedTitle) : null),
    [client, classId, isOpen, trimmedTitle],
  );

  const handleCreate = async () => {
    const trimmedTitle = title.trim();
    if (trimmedTitle === "") {
      setError("Title is required.");
      return;
    }
    // Validate the staged date/number rows BEFORE anything writes — an
    // honest error, cancel-grade (no half-created node).
    for (const { row, value } of entriesOf()) {
      if (value.kind === "date" && value.text.trim() !== "" && parseStagedDateText(value.text) === null) {
        setError(`${labelOf(row)} must be a date (YYYY, YYYY-MM, or YYYY-MM-DD).`);
        return;
      }
      if (
        value.kind === "number" &&
        value.text.trim() !== "" &&
        !Number.isFinite(Number(value.text.trim()))
      ) {
        setError(`${labelOf(row)} must be a number.`);
        return;
      }
    }

    setIsCreating(true);
    setError(null);
    try {
      if (citationFamily) {
        // The venue schemas/bindings a prefill carries self-heal before the
        // flush (the read-synthesis covered the form; the writes need real
        // rows).
        await ensureCitationFamily(
          client,
          prefill !== undefined ? venueKeysOfPrefill(prefill) : [],
          classId,
        );
      }
      const entries = entriesOf();
      if (citationFamily && draft !== null && draft.citekey !== "") {
        // Auto-citekey: the empty staged citekey rides the generated value
        // (the draft — pattern render + the deterministic collision suffix).
        const citekeyId = SYSTEM_PROPERTY_UUIDS.citekey;
        const citekeyEntry = entries.find(
          (entry) => entry.row.binding.propertySchemaId === citekeyId,
        );
        if (citekeyEntry !== undefined && stagedTextOf(citekeyEntry.value).trim() === "") {
          citekeyEntry.value = { kind: "text", text: draft.citekey };
        }
      }
      const id = await createClassedObject(client, {
        title: trimmedTitle,
        classId,
        values: entries,
        attachPdf: prefill?.pdf ?? null,
        unarchiveArchivedClass: true,
      });
      onCreated(id);
      onClose();
    } catch {
      setError("Failed to create. Please try again.");
      setIsCreating(false);
    }
  };

  const archivedSelection = isArchivedClass(client, classId);
  const className = classDisplayName(client, classId);
  const icon = classIconOf(client, classId);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`New ${className.toLowerCase()}`}
      headerLeftElement={
        icon !== null ? <Icon path={icon} size={0.9} className="quick-create-modal__icon" /> : undefined
      }
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleCreate()} disabled={isCreating} loading={isCreating}>
            Create
          </Button>
        </>
      }
    >
      <div className="quick-create-modal">
        <div className="quick-create-modal__field">
          <TextField
            ref={firstFieldRef}
            label="Title"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setError(null);
            }}
            placeholder={`${systemClassLabel(classId)} title`}
            autoComplete="off"
          />
        </div>
        <StagedPropertiesForm
          rows={rows}
          values={renderedValuesOf(rows, values, prefill)}
          onChange={(propertySchemaId, value) => {
            setValues((prev) => ({ ...prev, [propertySchemaId]: value }));
            setError(null);
          }}
        />
        {archivedSelection && (
          <p className="quick-create-modal__note" role="status">
            This class is archived — creating will enable it again.
          </p>
        )}
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
            . You can still create it again.
          </p>
        )}
        {titleDuplicate !== null && (
          <p className="quick-create-modal__warning" role="status">
            A {className.toLowerCase()} titled &quot;{trimmedTitle}&quot; already exists:{" "}
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
            . You can still create it again.
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

function labelOf(row: StagedPropertyBinding): string {
  return row.schema?.name ?? row.binding.name;
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
