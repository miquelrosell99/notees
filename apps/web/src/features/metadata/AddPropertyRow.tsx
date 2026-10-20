import { useRef, useState } from "react";

import { AddPill } from "../../components/ui/fleet/AddPill.js";
import { PropertyCreateModal } from "./PropertyCreateModal.js";
import { eligibleSchemasForNode } from "./schemaEligibility.js";
import { initializePropertyValue } from "./propertyValueInit.js";
import type { AnyClient } from "./shared.js";

/** "+ Add property": pick an existing schema (or create one) and realize an
 *  initial value on the node so the row appears. The candidate list is
 *  scope-gated (R1/R2 — a schema whose scopeClassIds excludes the node is
 *  not offered; the write path would fail loud anyway). The "Create …" row
 *  opens the S1 pre-creation modal (creation is a
 *  modal, not an instant minimal create) with the typed query carried in;
 *  after the create the placeholder value initializes the row as before. */
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

  async function initializeValue(schemaId: string, type: string): Promise<void> {
    try {
      await initializePropertyValue(client, nodeId, schemaId, type);
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
              .filter((schema) => newName.trim() === "" || schema.name.toLowerCase().includes(newName.trim().toLowerCase()))
              .map((schema) => (
                <li key={schema.id}>
                  <button type="button" onClick={() => void initializeValue(schema.id, schema.type)}>
                    <span className="nt-add-property-name">{schema.name}</span>
                    <span className="nt-add-property-type">{schema.type}</span>
                  </button>
                </li>
              ))}
          </ul>
          {newName.trim() !== "" && !schemas.some((s) => s.name.toLowerCase() === newName.trim().toLowerCase()) && (
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
          onCreated={(schemaId, type) => {
            void initializeValue(schemaId, type).then(() => setCreateOpen(false));
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}
