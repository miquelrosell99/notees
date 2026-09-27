/**
 * PropertiesPanel — the effective-properties panel on Page/Block views
 * (SCHEMA.md "Class properties"): authored property values plus derived
 * class-binding defaults, read through getEffectiveProperties.
 *
 * Rendering contract:
 *  - derived defaults render DIMMED with a "default" hint — they are
 *    configuration projections, not authored data;
 *  - editing any row writes an authored property.set, which from then on
 *    SHADOWS the default (the row flips to source "authored" on re-render);
 *  - an authored value whose class binding went away stays visible, marked
 *    "unbound" (authored values always survive — design law).
 *
 * The panel is node-typed agnostic: PageView mounts it for the page; any
 * future Block View can mount it for a block with the same props.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { EffectiveProperty, WorkspaceClient } from "@/core/workspace-client.js";

/** Text-round-trip of an authored/default value for the minimal editor. */
function toEditableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** Inverse: bare text stays a string; JSON-looking text parses (42, true, …). */
function fromEditableText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

export function PropertiesPanel({
  client,
  nodeId,
}: {
  client: WorkspaceClient | WorkerClient;
  nodeId: string;
}) {
  const rows = client.getEffectiveProperties(nodeId);
  if (rows.length === 0) return null;

  const labelOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;

  return (
    <section className="nt-class-panel nt-properties-panel" aria-label="Properties">
      <h2 className="nt-class-panel-title">Properties</h2>
      <ul className="nt-properties-list">
        {rows.map((row) => {
          const label = labelOf(row);
          const editable = toEditableText(row.value);
          return (
            <li
              key={`${row.propertySchemaId}:${row.idx}`}
              className={
                row.source === "default" ? "nt-property nt-property-default" : "nt-property"
              }
            >
              <span className="nt-property-name">{label}</span>
              {row.source === "default" && <span className="nt-property-hint">default</span>}
              {row.source === "authored" && row.boundBy === null && (
                <span className="nt-property-hint">unbound</span>
              )}
              <input
                key={`${row.propertySchemaId}:${row.idx}:${editable}`}
                type="text"
                className="nt-property-value"
                defaultValue={editable}
                aria-label={`Property ${label}`}
                onBlur={(event) => {
                  const next = fromEditableText(event.target.value);
                  // Deep-compare so a no-op blur never enqueues a write.
                  if (JSON.stringify(next) !== JSON.stringify(row.value)) {
                    void client.setProperty(nodeId, row.propertySchemaId, next, row.idx);
                  }
                }}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
