import { useRef, useState } from "react";

import { foldSearchText } from "@notees/store";

import { AddPill } from "../../components/ui/fleet/AddPill.js";
import { PropertyCreateModal } from "./PropertyCreateModal.js";
import { eligibleSchemasForNode } from "./schemaEligibility.js";
import type { AnyClient } from "./shared.js";

/** "+ Add property": assign an existing schema to the node — the row
 *  renders empty (owner ruling 2026-10-23: assignment WITHOUT a value, the
 *  v1 node_property lineage) and the row's own editor authors the first
 *  value whenever the user fills it. The candidate list is scope-gated
 *  (R1/R2 — a schema whose scopeClassIds excludes the node is not offered;
 *  the write path would fail loud anyway). The "Create …" row opens the S1
 *  pre-creation modal (owner ruling 2026-10-20: creation is a modal, not an
 *  instant minimal create) with the typed query carried in; after the
 *  create the schema is assigned as below. */
export function AddPropertyRow({
  client,
  nodeId,
}: {
  client: AnyClient;
  nodeId: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const node = client.getNode(nodeId);
  const schemas = client.listPropertySchemas();
  // S4: the candidate set is eligibility-gated (extends-aware closure).
  const candidates =
    node === undefined ? schemas : eligibleSchemasForNode(client, schemas, node);
  // Diacritics fold on both sides (the store search mirror): "ano" finds
  // the schema "año".
  const nameQuery = foldSearchText(newName.trim().toLowerCase());

  async function assign(schemaId: string): Promise<void> {
    try {
      await client.assignProperty(nodeId, schemaId);
      setPickerOpen(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** The create row hands off to the S1 modal: the popup closes, the modal
   *  takes over (the typed query carries in as the name). */
  function openCreateModal(): void {
    setPickerOpen(false);
    setCreateOpen(true);
  }

  return (
    <div className="nt-add-property">
      <AddPill
        ref={buttonRef}
        label="Add property"
        aria-expanded={pickerOpen}
        onClick={(element) => {
          buttonRef.current = element;
          setPickerOpen((open) => !open);
          setCreateOpen(false);
        }}
      />
      {pickerOpen && (
        <div className="nt-add-property-popup" role="dialog" aria-label="Add property">
          <input
            autoFocus
            placeholder="Search or create property…"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <ul>
            {candidates
              .filter((schema) => nameQuery === "" || foldSearchText(schema.name.toLowerCase()).includes(nameQuery))
              .map((schema) => (
                <li key={schema.id}>
                  <button type="button" onClick={() => void assign(schema.id)}>
                    <span className="nt-add-property-name">{schema.name}</span>
                    <span className="nt-add-property-type">{schema.type}</span>
                  </button>
                </li>
              ))}
          </ul>
          {newName.trim() !== "" && !schemas.some((s) => foldSearchText(s.name.toLowerCase()) === nameQuery) && (
            <button
              type="button"
              className="nt-add-property-create"
              onClick={openCreateModal}
            >
              Create property "{newName.trim()}"
            </button>
          )}
          {error !== null && <p className="nt-error">{error}</p>}
        </div>
      )}
      {createOpen && (
        <PropertyCreateModal
          isOpen
          client={client}
          initialName={newName.trim()}
          onCreated={(schemaId) => {
            void assign(schemaId).then(() => setCreateOpen(false));
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}
