/**
 * Alias property self-heal (§34.32 PG10, owner 2026-10-04) — the register
 * contradiction (v2 post-mortem deemed `node_alias` obsolete vs the
 * v1-parity register listing "Aliases (pages)") resolves to the v1-parity
 * side: a seeded multi-value `alias` text schema. The seed lives in the
 * domain manifest, but the server seed runs only on a completely empty
 * workspace — following the ensureCoverProperty precedent (§34.27 L2),
 * the web client authors the schema idempotently at the reserved id on
 * page view. Global scope, NO class binding: aliases are page metadata
 * and "page" is not a class in the render-state model — a binding would
 * narrow aliases to one class's members.
 *
 * Name-equivalence (SCHEMA.md "Aliases"): alias values fold into the FTS
 * row via the generic M5 text-scalar indexing, and the name-RESOLUTION
 * paths (resolveNodeByName, the server's GET /api/resolve, unlinked
 * references) treat an exact case-insensitive alias hit as the node's
 * name. Values are plain strings — the panel's scalar text editor; no
 * carrier blocks (an alias is a name, not a document).
 */

import { deriveDisplayName, SYSTEM_PROPERTY_DISPLAY_NAMES, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** True when the alias schema exists (any scope — the id is reserved). */
export function aliasPropertyPresent(
  client: Pick<AnyClient, "listPropertySchemas">,
): boolean {
  return client
    .listPropertySchemas()
    .some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.alias);
}

/** Author the alias schema when missing (idempotent; global scope, multi). */
export async function ensureAliasProperty(client: AnyClient): Promise<void> {
  if (aliasPropertyPresent(client)) return;
  await client.createPropertySchema({
    id: SYSTEM_PROPERTY_UUIDS.alias,
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.alias,
    type: "text",
    multi: true,
    scope: "global",
  });
}

/**
 * The node's alias values (slot order) — the name-equivalence read. Both
 * authored shapes count: a scalar string is the name itself; a node-backed
 * carrier reference (the generic Add-property path for text schemas
 * authors one) resolves to the carrier's content excerpt. The FTS row
 * indexes both shapes via the generic M5 text indexing, so resolution
 * follows search semantics either way.
 */
export function aliasValuesOf(
  client: Pick<AnyClient, "getEffectiveProperties" | "getNode">,
  nodeId: string,
): string[] {
  const rows = client
    .getEffectiveProperties(nodeId)
    .filter((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.alias && row.source === "authored");
  const values: string[] = [];
  for (const row of rows) {
    if (typeof row.value === "string" && row.value.trim() !== "") {
      values.push(row.value);
      continue;
    }
    const ref =
      typeof row.value === "object" &&
      row.value !== null &&
      "nodeId" in (row.value as object) &&
      typeof (row.value as { nodeId: unknown }).nodeId === "string"
        ? (row.value as { nodeId: string }).nodeId
        : null;
    if (ref !== null) {
      const carrier = client.getNode(ref);
      const name = carrier !== undefined ? deriveDisplayName(carrier) : null;
      if (name !== null && name.trim() !== "") values.push(name);
    }
  }
  return values;
}
