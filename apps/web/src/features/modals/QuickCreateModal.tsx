/**
 * QuickCreateModal — the class-aware create dialog. Opens from
 * a node picker's create row when the class filter resolves to the source
 * family (citation fields up front: type, title, authors, editors, year,
 * DOI, ISBN, URL, publisher, citekey + the resolved venue fields) or the
 * agent family (person: given/family split; organization: plain name —
 * ported). A plain page picker create stays plain: this modal only mounts
 * when resolveQuickCreate says a family applies. The add-source flow
 * (features/sources/AddSourceDialog) mounts it with a resolver PREFILL.
 *
 * The authors field is free text in the BibTeX "Family, Given" convention:
 * ";" or newline separates authors (a comma lives INSIDE a name), each
 * entry becomes ONE plain `authors` TEXT element — NO person find-or-create
 * (the 2026-10-23 owner ruling retyped `authors` to text; the node-typed
 * track is the separate `linkedAuthors` property). The type list FILTERS
 * archived type-classes (the class-visibility flag); a resolved archived
 * class stays selected (marked) and is auto-enabled at create — the
 * un-archive rides the SAME undo batch as the create. Auto-citekey fills an
 * empty citekey from the settings pattern when the toggle is on, with the
 * deterministic a/b/c collision suffix. A doi/isbn already on a live source
 * surfaces the "Already in your library" warning — the create stays allowed
 * (explicit override), the warning is honest. The citation schemas
 * self-heal on first use (ensureCitationFamily), so fresh/offline
 * workspaces work the same as server-seeded ones.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_DISPLAY_NAMES } from "@notees/domain";

import type { AnyClient } from "./quickCreate.js";
import {
  activeSourceSubclassOptions,
  createAgentObject,
  createSourceObject,
  displayNameOf,
  ensureCitationFamily,
  existingCitekeys,
  findSourceByIdentifier,
  generateCitekey,
  readSourceSettings,
  splitAuthorList,
  splitPersonName,
  systemClassLabel,
} from "./quickCreate.js";
import { Modal } from "../../components/ui/fleet/Modal.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { TextField } from "../../components/ui/fleet/TextField.js";
import { SelectionButton } from "../../components/ui/fleet/SelectionButton.js";
import "./QuickCreateModal.css";

export type AgentType = "person" | "organization";

/**
 * The add-source resolver prefill: the unified metadata record mapped onto
 * the modal's form (authors/editors as monoblock text, year as the 4-digit
 * chain year, the class's venue fields by pool key) plus the PDF attach
 * intent (the multipart upload's File — uploaded to CAS and linked on the
 * created node).
 */
export interface SourcePrefill {
  classId: string;
  title: string;
  authorsText: string;
  editorsText?: string | undefined;
  year?: string | undefined;
  doi?: string | undefined;
  isbn?: string | undefined;
  url?: string | undefined;
  publisher?: string | undefined;
  citekey?: string | undefined;
  /** The class's venue fields (pool property name → resolved value). */
  fields: Record<string, string>;
  /** The resolved-PDF attach intent (multipart mode). */
  pdf?: { file: Blob; filename: string } | null;
}

export interface QuickCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The workspace data surface the create composes through. */
  client: AnyClient;
  /** Which family dialog to render (from resolveQuickCreate). */
  kind: "source" | "agent";
  /** Preselected class (the filtered subclass when unambiguous). */
  defaultClassId: string;
  /** The picker's search query that found no match — prefills the title. */
  initialName?: string | undefined;
  /** The add-source resolver prefill (kind "source" only). */
  sourcePrefill?: SourcePrefill | undefined;
  /** Called with the new node id once created (the picker links it). */
  onCreated: (nodeId: string) => void;
  /** Opens the duplicate-warning's existing source (a link, when provided). */
  onOpenExisting?: ((nodeId: string) => void) | undefined;
}

export function QuickCreateModal({
  isOpen,
  onClose,
  client,
  kind,
  defaultClassId,
  initialName = "",
  sourcePrefill = undefined,
  onCreated,
  onOpenExisting = undefined,
}: QuickCreateModalProps) {
  // Source form state.
  const [title, setTitle] = useState("");
  const [sourceClassId, setSourceClassId] = useState<string>(SYSTEM_CLASS_UUIDS.book);
  const [authors, setAuthors] = useState("");
  const [editors, setEditors] = useState("");
  const [year, setYear] = useState("");
  const [doi, setDoi] = useState("");
  const [isbn, setIsbn] = useState("");
  const [url, setUrl] = useState("");
  const [publisher, setPublisher] = useState("");
  const [citekey, setCitekey] = useState("");
  const [venueKeys, setVenueKeys] = useState<string[]>([]);
  const [venueValues, setVenueValues] = useState<Record<string, string>>({});
  // Agent form state.
  const [agentType, setAgentType] = useState<AgentType>("person");
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [orgName, setOrgName] = useState("");

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Reset state each time the modal opens; split a free-typed person name
  // into given/family parts (the AgentQuickCreateModal behavior). A source
  // prefill (the add-source flow) wins over the picker's typed name.
  useEffect(() => {
    if (!isOpen) return;
    if (kind === "source" && sourcePrefill !== undefined) {
      setTitle(sourcePrefill.title);
      setSourceClassId(sourcePrefill.classId);
      setAuthors(sourcePrefill.authorsText);
      setEditors(sourcePrefill.editorsText ?? "");
      setYear(sourcePrefill.year ?? "");
      setDoi(sourcePrefill.doi ?? "");
      setIsbn(sourcePrefill.isbn ?? "");
      setUrl(sourcePrefill.url ?? "");
      setPublisher(sourcePrefill.publisher ?? "");
      setCitekey(sourcePrefill.citekey ?? "");
      setVenueKeys(Object.keys(sourcePrefill.fields));
      setVenueValues({ ...sourcePrefill.fields });
    } else {
      setTitle(initialName);
      setSourceClassId(
        kind === "source" && defaultClassId !== SYSTEM_CLASS_UUIDS.source
          ? defaultClassId
          : SYSTEM_CLASS_UUIDS.book,
      );
      setAuthors("");
      setEditors("");
      setYear("");
      setDoi("");
      setIsbn("");
      setUrl("");
      setPublisher("");
      setCitekey("");
      setVenueKeys([]);
      setVenueValues({});
    }
    setAgentType(defaultClassId === SYSTEM_CLASS_UUIDS.organization ? "organization" : "person");
    const split = splitPersonName(initialName);
    setGivenName(split.givenName);
    setFamilyName(split.familyName);
    setOrgName(initialName);
    setError(null);
    setIsCreating(false);
    const timer = setTimeout(() => firstFieldRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [isOpen, initialName, kind, defaultClassId, sourcePrefill]);

  const handleCreate = async () => {
    const trimmedTitle = title.trim();
    const trimmedYear = year.trim();
    if (kind === "source" && trimmedTitle === "") {
      setError("Title is required.");
      return;
    }
    if (kind === "agent") {
      const name =
        agentType === "person"
          ? [givenName.trim(), familyName.trim()].filter(Boolean).join(" ")
          : orgName.trim();
      if (name === "") {
        setError("Name is required.");
        return;
      }
    }
    if (kind === "source" && trimmedYear !== "" && !/^\d{4}$/.test(trimmedYear)) {
      setError("Publication year must be a 4-digit year (e.g. 1965).");
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      await ensureCitationFamily(client, venueKeys);
      let id: string;
      if (kind === "source") {
        const settings = readSourceSettings(client);
        const authorList = splitAuthorList(authors);
        const trimmedCitekey = citekey.trim();
        // Auto-citekey: the setting is on AND the field is empty — pattern
        // render + the deterministic a/b/c collision suffix over the live
        // citekeys (case-insensitive).
        const citekeyValue =
          trimmedCitekey !== ""
            ? trimmedCitekey
            : settings.autoCitekey
              ? generateCitekey(
                  settings.citekeyPattern,
                  {
                    authors: authorList,
                    year: trimmedYear === "" ? null : Number(trimmedYear),
                    title: trimmedTitle,
                  },
                  existingCitekeys(client),
                )
              : "";
        id = await createSourceObject(client, {
          title: trimmedTitle,
          classId: sourceClassId,
          authors: authorList,
          editors: splitAuthorList(editors),
          doi: doi.trim(),
          isbn: isbn.trim(),
          url: url.trim(),
          publisher: publisher.trim(),
          citekey: citekeyValue,
          publicationYear: trimmedYear === "" ? null : Number.parseInt(trimmedYear, 10),
          venueFields: venueValues,
          attachPdf: sourcePrefill?.pdf ?? null,
          unarchiveArchivedClass: true,
        });
      } else {
        id = await createAgentObject(client, {
          agentType,
          name: orgName,
          givenName,
          familyName,
        });
      }
      onCreated(id);
      onClose();
    } catch {
      setError("Failed to create. Please try again.");
      setIsCreating(false);
    }
  };

  // The type list filters archived classes (Review N1); a resolved archived
  // class stays visible as the current selection (marked) until the user
  // picks a live type — the un-archive happens at create.
  const allSourceOptions = activeSourceSubclassOptions(client);
  const archivedSelection =
    kind === "source" && !allSourceOptions.some((option) => option.value === sourceClassId);
  const sourceOptions = archivedSelection
    ? [
        ...allSourceOptions,
        {
          value: sourceClassId,
          label: `${systemClassLabel(sourceClassId)} (archived)`,
          icon: "mdi-archive-outline",
        },
      ]
    : allSourceOptions;

  // The duplicate warning: the prefilled (or typed) doi/isbn already on a
  // live source. The create stays allowed — the warning is honest. Memoized
  // on the identifiers (the scan walks the source family) — it re-runs only
  // when the DOI/ISBN fields change.
  const duplicate = useMemo(
    () => (kind === "source" ? findSourceByIdentifier(client, { doi, isbn }) : null),
    [kind, client, doi, isbn],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        kind === "source"
          ? `New ${systemClassLabel(sourceClassId).toLowerCase()}`
          : agentType === "person"
            ? "New person"
            : "New organization"
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
        {kind === "source" ? (
          <>
            <div className="quick-create-modal__field">
              <SelectionButton
                label="Type"
                options={sourceOptions}
                value={sourceClassId}
                onChange={setSourceClassId}
                size="sm"
              />
            </div>
            <div className="quick-create-modal__field">
              <TextField
                ref={firstFieldRef}
                label="Title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setError(null);
                }}
                placeholder="Source title"
                autoComplete="off"
              />
            </div>
            <div className="quick-create-modal__field">
              <TextField
                label="Authors"
                value={authors}
                onChange={(event) => {
                  setAuthors(event.target.value);
                  setError(null);
                }}
                placeholder="Family, Given; Family, Given"
                autoComplete="off"
              />
            </div>
            <div className="quick-create-modal__field">
              <TextField
                label="Editors"
                value={editors}
                onChange={(event) => {
                  setEditors(event.target.value);
                  setError(null);
                }}
                placeholder="Family, Given; Family, Given"
                autoComplete="off"
              />
            </div>
            <div className="quick-create-modal__row">
              <div className="quick-create-modal__field">
                <TextField
                  label="Year"
                  value={year}
                  onChange={(event) => {
                    setYear(event.target.value);
                    setError(null);
                  }}
                  placeholder="1965"
                  inputMode="numeric"
                  autoComplete="off"
                />
              </div>
              <div className="quick-create-modal__field">
                <TextField
                  label="DOI"
                  value={doi}
                  onChange={(event) => {
                    setDoi(event.target.value);
                    setError(null);
                  }}
                  placeholder="10.…"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="quick-create-modal__row">
              <div className="quick-create-modal__field">
                <TextField
                  label="ISBN"
                  value={isbn}
                  onChange={(event) => {
                    setIsbn(event.target.value);
                    setError(null);
                  }}
                  placeholder="978-…"
                  autoComplete="off"
                />
              </div>
              <div className="quick-create-modal__field">
                <TextField
                  label="URL"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setError(null);
                  }}
                  placeholder="https://…"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="quick-create-modal__row">
              <div className="quick-create-modal__field">
                <TextField
                  label="Publisher"
                  value={publisher}
                  onChange={(event) => {
                    setPublisher(event.target.value);
                    setError(null);
                  }}
                  placeholder="Publishing house"
                  autoComplete="off"
                />
              </div>
              <div className="quick-create-modal__field">
                <TextField
                  label="Citekey"
                  value={citekey}
                  onChange={(event) => {
                    setCitekey(event.target.value);
                    setError(null);
                  }}
                  placeholder="Auto-filled when empty"
                  autoComplete="off"
                />
              </div>
            </div>
            {venueKeys.map((key) => (
              <div className="quick-create-modal__field" key={key}>
                <TextField
                  label={SYSTEM_PROPERTY_DISPLAY_NAMES[key as keyof typeof SYSTEM_PROPERTY_DISPLAY_NAMES] ?? key}
                  value={venueValues[key] ?? ""}
                  onChange={(event) => {
                    setVenueValues((prev) => ({ ...prev, [key]: event.target.value }));
                    setError(null);
                  }}
                  autoComplete="off"
                />
              </div>
            ))}
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
          </>
        ) : (
          <>
            <div className="quick-create-modal__field">
              <SelectionButton
                label="Type"
                options={[
                  { value: "person", label: "Person", icon: "mdi-account-outline" },
                  { value: "organization", label: "Organization", icon: "mdi-domain" },
                ]}
                value={agentType}
                onChange={(value) => setAgentType(value as AgentType)}
                size="sm"
              />
            </div>
            {agentType === "person" ? (
              <>
                <div className="quick-create-modal__field">
                  <TextField
                    ref={firstFieldRef}
                    label="Given name"
                    value={givenName}
                    onChange={(event) => {
                      setGivenName(event.target.value);
                      setError(null);
                    }}
                    placeholder="Frank"
                    autoComplete="off"
                  />
                </div>
                <div className="quick-create-modal__field">
                  <TextField
                    label="Family name"
                    value={familyName}
                    onChange={(event) => {
                      setFamilyName(event.target.value);
                      setError(null);
                    }}
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
                  onChange={(event) => {
                    setOrgName(event.target.value);
                    setError(null);
                  }}
                  placeholder="Organization name"
                  autoComplete="off"
                />
              </div>
            )}
          </>
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
