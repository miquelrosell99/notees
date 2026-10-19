import { useRef, useState } from "react";

import { todayIsoLocal } from "../calendar/calendarViewUtils.js";
import { AddPill } from "../../ui/components/ui/AddPill.js";
import type { AnyClient } from "./shared.js";

/** "+ Add property": pick an existing schema (or create one) and realize an
 *  initial value on the node so the row appears. */
export function AddPropertyRow({
  client,
  nodeId,
}: {
  client: AnyClient;
  nodeId: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const schemas = client.listPropertySchemas();

  async function initializeValue(schemaId: string, type: string): Promise<void> {
    switch (type) {
      case "boolean":
        await client.setProperty(nodeId, schemaId, true, 0);
        return;
      case "number":
        await client.setProperty(nodeId, schemaId, 0, 0);
        return;
      case "text": {
        // Node-backed: a fresh carrier block child holds the text.
        const carrier = await client.createObject({
          parentId: nodeId,
          contentAst: [{ type: "text", text: "" }],
        });
        await client.setProperty(nodeId, schemaId, { nodeId: carrier }, 0);
        return;
      }
      case "datetime": {
        // Local midnight, not UTC — the "today" default must match the
        // user's calendar day. Full-day: the point carries no time.
        const dayId = await client.ensureDateChain(todayIsoLocal());
        await client.setProperty(nodeId, schemaId, { nodeId: dayId }, 0);
        return;
      }
      default:
        // url/email/select/multi_select/object/image: no sensible empty
        // value — the row's own editor will prompt on first edit.
        return;
    }
  }

  async function pickSchema(schemaId: string, type: string): Promise<void> {
    setError(null);
    try {
      await initializeValue(schemaId, type);
      setPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createSchema(): Promise<void> {
    const name = newName.trim();
    if (name === "") return;
    setError(null);
    try {
      const schemaId = await client.createPropertySchema({ name, type: "text" });
      await initializeValue(schemaId, "text");
      setCreating(false);
      setNewName("");
      setPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
          setCreating(false);
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
            {schemas
              .filter((schema) => newName.trim() === "" || schema.name.toLowerCase().includes(newName.trim().toLowerCase()))
              .map((schema) => (
                <li key={schema.id}>
                  <button type="button" onClick={() => void pickSchema(schema.id, schema.type)}>
                    <span className="nt-add-property-name">{schema.name}</span>
                    <span className="nt-add-property-type">{schema.type}</span>
                  </button>
                </li>
              ))}
          </ul>
          {newName.trim() !== "" && !schemas.some((s) => s.name.toLowerCase() === newName.trim().toLowerCase()) && (
            <button type="button" className="nt-add-property-create" onClick={() => void createSchema()}>
              Create property "{newName.trim()}"
            </button>
          )}
          {error !== null && <p className="nt-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
