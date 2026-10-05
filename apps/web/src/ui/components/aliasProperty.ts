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
 * Node aliases (issue #7, owner 2026-10-05) coexist: the seeded
 * single-value node-typed `aliasOf` schema links an ALIAS PAGE to its MAIN
 * page (the alias carries {nodeId} of the main — one-way). Both schemas
 * self-heal here; the roll-up read path lives in the workspace client.
 *
 * Name-equivalence (SCHEMA.md "Aliases"): alias values fold into the FTS
 * row via the generic M5 text-scalar indexing, and the name-RESOLUTION
 * paths (resolveNodeByName, the server's GET /api/resolve, unlinked
 * references) treat an exact case-insensitive alias hit as the node's
 * name. Values are plain strings — the panel's scalar text editor; no
 * carrier blocks (an alias is a name, not a document).
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
 * Node-alias schema self-heal (issue #7): the seeded single-value
 * node-typed `aliasOf` schema (global scope, no class binding — both the
 * carrier and the target are pages, and "page" is not a class). Idempotent
 * at the reserved id; the page view runs it alongside ensureAliasProperty.
 */
export async function ensureAliasOfProperty(client: AnyClient): Promise<void> {
  const present = client
    .listPropertySchemas()
    .some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.aliasOf);
  if (present) return;
  await client.createPropertySchema({
    id: SYSTEM_PROPERTY_UUIDS.aliasOf,
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.aliasOf,
    type: "object",
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

/**
 * The ALIAS→MAIN read (issue #7): the authored `aliasOf` value's {nodeId}
 * — the main page the given alias page points at. Null when the node
 * carries no authored aliasOf value (an ordinary page/block) or the value
 * is not a node reference. Authored rows only; single-value, so the first
 * authored slot wins.
 */
export function aliasOfTargetOf(
  client: Pick<AnyClient, "getEffectiveProperties">,
  nodeId: string,
): string | null {
  const row = client
    .getEffectiveProperties(nodeId)
    .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.aliasOf && entry.source === "authored");
  if (row === undefined) return null;
  const value = row.value;
  if (
    typeof value === "object" &&
    value !== null &&
    "nodeId" in (value as object) &&
    typeof (value as { nodeId: unknown }).nodeId === "string"
  ) {
    return (value as { nodeId: string }).nodeId;
  }
  return null;
}

/**
 * The write-path guard for `aliasOf` (issue #7, client-side enforcement):
 * the target must render as a PAGE (document chrome — the render-state
 * restriction; "page" is not a class, so no schema-level filter expresses
 * it). Returns the visible error message, or null when the target is
 * writable. The alias row calls this before writing; nothing else
 * validates (other clients / raw op writers are not policed — documented
 * in SCHEMA.md "Node aliases").
 */
export function aliasOfPageTargetError(
  client: Pick<AnyClient, "getNode">,
  targetId: string,
): string | null {
  const target = client.getNode(targetId);
  if (target === undefined || !rendersWithDocumentChrome(target)) {
    return "Alias of: the target must be a page.";
  }
  return null;
}

/**
 * Resolve-alias indirection for navigation (issue #7): a mention/link
 * whose target is an alias page opens the MAIN page instead — the alias
 * page itself stays reachable by opening it as a node (search, child
 * rows, deep links). Returns the id unchanged when the node is not an
 * alias page (not document chrome, no aliasOf value, or a broken target).
 * Chains (an alias of an alias) collapse to the final main page; a cycle
 * yields the original id (defensive — never loops).
 */
export function resolveAliasOpen(
  client: Pick<AnyClient, "getEffectiveProperties" | "getNode">,
  nodeId: string,
): string {
  const seen = new Set<string>([nodeId]);
  let current = nodeId;
  for (let guard = 0; guard < 16; guard += 1) {
    const node = client.getNode(current);
    if (node === undefined || !rendersWithDocumentChrome(node)) return current === nodeId ? nodeId : current;
    const target = aliasOfTargetOf(client, current);
    if (target === null) return current;
    const targetNode = client.getNode(target);
    if (targetNode === undefined || !rendersWithDocumentChrome(targetNode)) return current;
    if (seen.has(target)) return current === nodeId ? nodeId : current;
    seen.add(target);
    current = target;
  }
  return current;
}
