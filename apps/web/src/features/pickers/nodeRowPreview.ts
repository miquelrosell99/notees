/**
 * nodeRowPreview — the node-row preview line: one compact `" · "`-joined
 * metadata line a node result row (picker/search) renders under its name
 * when one of the node's classes binds a property with the `showInNodeRows`
 * flag (the Add-Source preview card's meta idiom — bare formatted values,
 * no labels). The values ride the shared propertyDisplayText funnel
 * (dates honor the schema precision via the date-node ref, multi values
 * join with ", ", relation values resolve to target names, empty values
 * are omitted) — the same read contract the table/cards views render from.
 *
 * Performance contract: rows without a flagged binding pay nothing beyond
 * the (cached) class-binding reads — the effective-values read happens
 * ONLY when at least one binding is flagged, and only the flagged schemas'
 * rows are formatted.
 */

import type {
  ClassBinding,
  ClientNode,
  ClientPropertySchema,
  EffectiveProperty,
} from "@/core/workspace-client/index.js";
import {
  isEmptyPropertyValue,
  propertyDisplayText,
  type PropertyDisplayClient,
} from "../collection/propertyDisplay.js";

/**
 * The client seams the preview line derives from. The first two are the
 * row's existing fresh-read surface; the last three are the binding
 * registry + the effective-values read + the schema registry (select
 * option labels). `getEffectiveProperties` keeps the quick-create surface's
 * narrow row shape so every picker client satisfies the seam structurally;
 * rows are validated as FULL effective rows before they are formatted
 * (a quick-create row lacks the schema and is skipped). All five are
 * optional — a caller that cannot supply them (a narrow context client)
 * simply renders no metadata line.
 */
export interface NodeRowPreviewClient {
  getNode(id: string): ClientNode | undefined;
  getDisplayName?(id: string): string | null;
  getClassBindings?(classId: string): ClassBinding[];
  getEffectiveProperties?(id: string): Array<{ propertySchemaId: string; value: unknown }>;
  listPropertySchemas?(): ClientPropertySchema[];
}

/** True when the row is a FULL effective row (the quick-create surface's
 *  narrow {propertySchemaId, value} rows are not — no schema, no elementId). */
function isEffectiveRow(row: unknown): row is EffectiveProperty {
  return (
    typeof row === "object" &&
    row !== null &&
    "propertySchemaId" in row &&
    "value" in row &&
    "elementId" in row
  );
}

/**
 * The metadata line for one node row, or null when there is nothing to
 * render (no client, no flagged binding, or every flagged value is empty).
 * `node` is the pooled row; the classes ride the FRESH per-node read (the
 * pooled listings can lag a re-class), falling back to the pooled row's
 * own classIds.
 */
export function nodeRowPreviewLine(
  client: NodeRowPreviewClient | undefined,
  node: ClientNode,
): string | null {
  // Destructure first so the undefined guards narrow the LOCALS — the
  // narrowing then holds inside the closures below (method-style seams,
  // re-bound to the client at the call sites).
  const getDisplayName = client?.getDisplayName;
  const getClassBindings = client?.getClassBindings;
  const getEffectiveProperties = client?.getEffectiveProperties;
  const listPropertySchemas = client?.listPropertySchemas;
  if (
    client === undefined ||
    getDisplayName === undefined ||
    getClassBindings === undefined ||
    getEffectiveProperties === undefined ||
    listPropertySchemas === undefined
  ) {
    return null;
  }
  const fresh = client.getNode(node.id) ?? node;
  // The flagged bindings across the node's classes, in class order (the
  // pill order); the first class claiming a schema wins (extends-aware
  // getClassBindings already orders own rows first). Inactive bindings do
  // not contribute (the soft-unbind stops the binding entirely).
  const flagged: ClassBinding[] = [];
  const claimed = new Set<string>();
  for (const classId of fresh.classIds) {
    for (const binding of getClassBindings.call(client, classId)) {
      if (!binding.showInNodeRows || !binding.active) continue;
      if (claimed.has(binding.propertySchemaId)) continue;
      claimed.add(binding.propertySchemaId);
      flagged.push(binding);
    }
  }
  if (flagged.length === 0) return null;
  const rows = getEffectiveProperties.call(client, node.id).filter(isEffectiveRow);
  const displayClient: PropertyDisplayClient = {
    getNode: (id) => client.getNode(id),
    getDisplayName: (id) => getDisplayName.call(client, id),
    listPropertySchemas: () => listPropertySchemas.call(client),
  };
  const segments: string[] = [];
  for (const binding of flagged) {
    // One segment per flagged schema: every valued row formatted (multi
    // rows are separate (schema, idx) rows), empty rows omitted.
    const texts = rows
      .filter(
        (row) =>
          row.propertySchemaId === binding.propertySchemaId &&
          !isEmptyPropertyValue(row.value),
      )
      .map((row) => propertyDisplayText(displayClient, row))
      .filter((text) => text !== "");
    if (texts.length === 0) continue;
    segments.push(texts.join(", "));
  }
  if (segments.length === 0) return null;
  return segments.join(" · ");
}
