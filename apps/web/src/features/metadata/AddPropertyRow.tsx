import { useEffect, useRef, useState } from "react";

import { foldSearchText } from "@notees/store";

import { AddPill } from "../../components/ui/fleet/AddPill.js";
import { PropertyCreateModal } from "./PropertyCreateModal.js";
import { ScopeRemedyButton } from "./ScopeRemedyButton.js";
import { eligibleSchemasForNode, realizeCandidatesOf } from "./schemaEligibility.js";
import type { AnyClient } from "./shared.js";

/** "+ Add property": assign an existing schema to the node — the row
 *  renders empty (assignment WITHOUT a value, the
 *  v1 node_property lineage) and the row's own editor authors the first
 *  value whenever the user fills it. The candidate list is scope-gated
 *  (R1/R2 — a schema whose scopeClassIds excludes the node is not offered;
 *  the write path would fail loud anyway). Bound-but-unrealized properties
 *  (virtual through a node's classes — the virtual/realized assessment,
 * ) ride the same gesture with a "Realize … · from
 *  <class>" tag: pinning (property.assign) makes the property survive class
 *  removal on its own. Realized schemas (valued or pinned) drop out of the
 *  picker entirely — their rows already render. The "Create …" row opens
 *  the S1 pre-creation modal (creation is a modal,
 *  not an instant minimal create) with the typed query carried in; after
 *  the create the schema is assigned as below. */
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
  /** The schema whose write failed with a scope rejection — the error line
   *  carries the guided remedy beneath it (dead-end removal, Tier 3). */
  const [failedSchemaId, setFailedSchemaId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // The subscription (the established metadata pattern): the remedy's
  // class.setExtends lands through the ordinary op path and the picker
  // must re-derive its eligible/ineligible split while it stays open.
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const node = client.getNode(nodeId);
  const schemas = client.listPropertySchemas();
  // S4: the candidate set is eligibility-gated (extends-aware closure)…
  const eligible =
    node === undefined ? schemas : eligibleSchemasForNode(client, schemas, node);
  // …minus the REALIZED (the virtual/realized assessment): a valued or
  // pinned schema's row already renders — re-adding would be a no-op.
  const { realize, realizedIds } =
    node === undefined
      ? { realize: new Map<string, string>(), realizedIds: new Set<string>() }
      : realizeCandidatesOf(client, node);
  const candidates = eligible.filter((schema) => !realizedIds.has(schema.id));
  // Realize entries lead (the node's own class context), then the rest;
  // pure alphabetical by folded name inside each group (the panels'
  // alphabetical ruling rides the picker too).
  const folded = (name: string) => foldSearchText(name.toLowerCase());
  const ordered = [...candidates].sort((a, b) => {
    const groupDelta = (realize.has(a.id) ? 0 : 1) - (realize.has(b.id) ? 0 : 1);
    if (groupDelta !== 0) return groupDelta;
    return folded(a.name).localeCompare(folded(b.name));
  });
  // Diacritics fold on both sides (the store search mirror): "ano" finds
  // the schema "año".
  const nameQuery = foldSearchText(newName.trim().toLowerCase());
  // The guided scope remedy (Tier 3): an INELIGIBLE schema whose name
  // matches the search stays visible — disabled, with the "Let <class>
  // extend <scope class>?" offer beneath it. The user is looking for it;
  // hiding it entirely was the dead end.
  const eligibleIds = new Set(eligible.map((schema) => schema.id));
  const ineligibleMatches =
    nameQuery === ""
      ? []
      : schemas.filter(
          (schema) =>
            !eligibleIds.has(schema.id) &&
            !realizedIds.has(schema.id) &&
            foldSearchText(schema.name.toLowerCase()).includes(nameQuery),
        );

  async function assign(schemaId: string): Promise<void> {
    try {
      await client.assignProperty(nodeId, schemaId);
      setPickerOpen(false);
      setError(null);
      setFailedSchemaId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setFailedSchemaId(/not eligible for schema/.test(message) ? schemaId : null);
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
            {ordered
              .filter((schema) => nameQuery === "" || foldSearchText(schema.name.toLowerCase()).includes(nameQuery))
              .map((schema) => {
                const binder = realize.get(schema.id);
                return (
                  <li key={schema.id}>
                    <button
                      type="button"
                      title={
                        binder !== undefined
                          ? `Realize ${schema.name} from ${binder} — pin it to this node`
                          : undefined
                      }
                      onClick={() => void assign(schema.id)}
                    >
                      <span className="nt-add-property-name">{schema.name}</span>
                      <span
                        className={
                          binder !== undefined
                            ? "nt-add-property-type nt-add-property-type--realize"
                            : "nt-add-property-type"
                        }
                      >
                        {binder !== undefined ? `realize · from ${binder}` : schema.type}
                      </span>
                    </button>
                  </li>
                );
              })}
            {/* The ineligible search matches stay visible — disabled, with
                the remedy offer beneath (never a silent dead end). */}
            {ineligibleMatches.map((schema) => (
              <li key={schema.id} className="nt-add-property-ineligible">
                <button
                  type="button"
                  disabled
                  title="This node's classes don't cover this property's scope"
                >
                  <span className="nt-add-property-name">{schema.name}</span>
                  <span className="nt-add-property-type">not eligible</span>
                </button>
                <ScopeRemedyButton client={client} nodeId={nodeId} schema={schema} />
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
        </div>
      )}
      {/* The write-error line + the guided remedy ride OUTSIDE the popup: a
          rejection from the create-modal handoff (the picker closed) must
          stay visible — the remedy is the way out of it. */}
      {error !== null && <p className="nt-error">{error}</p>}
      {failedSchemaId !== null &&
        (() => {
          const failedSchema = schemas.find((s) => s.id === failedSchemaId);
          return failedSchema === undefined ? null : (
            <ScopeRemedyButton client={client} nodeId={nodeId} schema={failedSchema} />
          );
        })()}
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
