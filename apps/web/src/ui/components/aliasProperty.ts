/**
 * Text aliases + the node-alias navigation seam (SCHEMA.md "Node aliases").
 *
 * The TEXT alias system (a page's alternate NAMES) rides the seeded
 * multi-value `alias` text schema: values fold into the FTS row via the
 * generic text-scalar indexing, and the name-RESOLUTION paths
 * (resolveNodeByName, the server's GET /api/resolve, unlinked references)
 * treat an exact case-insensitive alias hit as the node's name. Values are
 * plain strings — no carrier blocks (an alias is a name, not a document).
 * The schema self-heals here (the server seed runs only on a completely
 * empty workspace — the ensureTaskFamily precedent): global scope, NO
 * class binding — aliases are page metadata and "page" is not a class in
 * the render-state model.
 *
 * The NODE alias system (a page linking UNDER another page) rides the
 * `aliasedNodeId` wire node field — many-to-one FROM the alias, mapped by
 * object.update, cycle-checked at the applier. The property-based carrier
 * (the retired `aliasOf` schema) is gone: every read below goes through the
 * node column. The redirect seam (resolveAliasOpen) and the write guard
 * (aliasedNodeTargetError) live here; the aliases UI (the metadata panel's
 * Aliases row + the alias-side pseudo-property row) composes them.
 */

import { deriveDisplayName, rendersWithDocumentChrome, SYSTEM_PROPERTY_DISPLAY_NAMES, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

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
 * indexes both shapes via the generic text indexing, so resolution
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

/**
 * The write-path guard for the `aliasedNodeId` field (client-side
 * enforcement, by design — SCHEMA.md "Node aliases"): the target must
 * render as a PAGE (document chrome — the render-state restriction;
 * "page" is not a class, so no schema-level filter expresses it). Returns
 * the visible error message, or null when the target is writable. The
 * aliases UI calls this before writing (the pickers offer pages only, but
 * the guard is the enforcement); nothing else validates — other clients /
 * raw op writers are not policed, and non-page values then simply don't
 * act as aliases (every read filters to pages).
 */
export function aliasedNodeTargetError(
  client: Pick<AnyClient, "getNode">,
  targetId: string,
): string | null {
  const target = client.getNode(targetId);
  if (target === undefined || !rendersWithDocumentChrome(target)) {
    return "Aliased node: the target must be a page.";
  }
  return null;
}

/**
 * THE alias navigation seam: the terminal of a node-alias chain, via the
 * store's cycle-safe chain walker (`client.resolveAlias`). Every App open
 * funnel resolves opens through this helper, so mentions, links, sidebar
 * rows, backlink/query result rows, palette rows, breadcrumbs and graph
 * clicks all land on the terminal; the aliases UI's NAVIGATE is the one
 * deliberate bypass (it opens the alias node's OWN view). The id comes
 * back unchanged for ordinary nodes, cyclic chains (a cyclic alias is no
 * alias — the SCHEMA.md ruling) and unknown ids.
 */
export function resolveAliasOpen(
  client: Pick<AnyClient, "resolveAlias">,
  nodeId: string,
): string {
  return client.resolveAlias(nodeId);
}
