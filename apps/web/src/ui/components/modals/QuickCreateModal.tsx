/**
 * QuickCreateModal — the class-aware create dialog. Opens from
 * a node picker's create row when the class filter resolves to the source
 * family (citation fields up front: type, title, authors, year, DOI) or the
 * agent family (person: given/family split; organization: plain name —
 * ported). A plain page picker create stays plain: this
 * modal only mounts when resolveQuickCreate says a family applies.
 *
 * The authors field is free text (comma-separated names): bibliography
 * authors ARE agent nodes, so each name becomes — or reuses — a linked
 * person node; a single-word name is treated as the family name (Zotero
 * single-field convention). The citation schemas self-heal on first use
 * (ensureCitationFamily), so fresh/offline workspaces work the same as
 * server-seeded ones.
 */

import { useEffect, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "./quickCreate.js";
import {
  createAgentObject,
  createSourceObject,
  ensureCitationFamily,
  sourceSubclassOptions,
  splitPersonName,
  systemClassLabel,
} from "./quickCreate.js";
import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { TextField } from "../ui/TextField.js";
import { SelectionButton } from "../ui/SelectionButton.js";
import "./QuickCreateModal.css";

export type AgentType = "person" | "organization";

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
  /** Called with the new node id once created (the picker links it). */
  onCreated: (nodeId: string) => void;
}

export function QuickCreateModal({
  isOpen,
  onClose,
  client,
  kind,
  defaultClassId,
  initialName = "",
  onCreated,
}: QuickCreateModalProps) {
  // Source form state.
  const [title, setTitle] = useState("");
  const [sourceClassId, setSourceClassId] = useState<string>(SYSTEM_CLASS_UUIDS.book);
  const [authors, setAuthors] = useState("");
  const [year, setYear] = useState("");
  const [doi, setDoi] = useState("");
  // Agent form state.
  const [agentType, setAgentType] = useState<AgentType>("person");
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [orgName, setOrgName] = useState("");

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Reset state each time the modal opens; split a free-typed person name
  // into given/family parts (the AgentQuickCreateModal behavior).
  useEffect(() => {
    if (!isOpen) return;
    setTitle(initialName);
    setSourceClassId(
      kind === "source" && defaultClassId !== SYSTEM_CLASS_UUIDS.source
        ? defaultClassId
        : SYSTEM_CLASS_UUIDS.book,
    );
    setAuthors("");
    setYear("");
    setDoi("");
    setAgentType(defaultClassId === SYSTEM_CLASS_UUIDS.organization ? "organization" : "person");
    const split = splitPersonName(initialName);
    setGivenName(split.givenName);
    setFamilyName(split.familyName);
    setOrgName(initialName);
    setError(null);
    setIsCreating(false);
    const timer = setTimeout(() => firstFieldRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [isOpen, initialName, kind, defaultClassId]);

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
      await ensureCitationFamily(client);
      let id: string;
      if (kind === "source") {
        id = await createSourceObject(client, {
          title: trimmedTitle,
          classId: sourceClassId,
          authors: authors.split(/[,;]/).map((name) => name.trim()),
          doi: doi.trim(),
          publicationYear: trimmedYear === "" ? null : Number.parseInt(trimmedYear, 10),
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

  const sourceOptions = sourceSubclassOptions();

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
                placeholder="Ada Lovelace, Alan Turing"
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
