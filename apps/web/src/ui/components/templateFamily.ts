/**
 * Template family — §34.25 T2. The `has-template` system property (fixed UUID
 * in @notees/domain seeds, §34.28 #2's lesson applied: a reserved UUID is
 * dead without an author) binds a CLASS node to its template nodes
 * (node-typed, multi, `targetClassFilter: ["template"]` — SCHEMA.md
 * "Templates", owner decision D1).
 *
 * The seeded spec rides the server seed (buildSeedEnvelopes iterates
 * SYSTEM_PROPERTY_SPECS), so fresh workspaces get the schema + the binding to
 * the system `class` class from boot. ensureTemplateProperty self-heals
 * pre-existing / offline-first workspaces idempotently — the ensureTaskFamily
 * pattern — and the create flow calls it before reading a class's templates.
 *
 * Safe under both WorkspaceClient and WorkerClient — it composes only the
 * shared write surface (createClass / createPropertySchema / setClassProperty)
 * and sync reads (listPropertySchemas / getClassBindings / getNode), all
 * RPC-mirrored.
 */

import { SYSTEM_CLASS_ICONS, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ClientPropertySchema, WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

const HAS_TEMPLATE_ID = SYSTEM_PROPERTY_UUIDS.hasTemplate;

/** True when the has-template schema exists and is bound to the system `class` class. */
export function templatePropertyPresent(
  client: Pick<AnyClient, "listPropertySchemas" | "getClassBindings">,
): boolean {
  const schemas = client.listPropertySchemas();
  const schema = schemas.find((entry: ClientPropertySchema) => entry.id === HAS_TEMPLATE_ID);
  if (schema === undefined) return false;
  const bound = client
    .getClassBindings(SYSTEM_CLASS_UUIDS.class)
    .map((binding) => binding.propertySchemaId);
  return bound.includes(HAS_TEMPLATE_ID);
}

/**
 * Author the has-template schema + system-class binding when missing; a
 * complete no-op once present (idempotent — safe to call on every create).
 * Self-heals the system `class` class node at its reserved id when the
 * workspace was never seeded (offline-first devices), else the binding rows
 * are invisible to getClassBindings and every call would re-author them.
 */
export async function ensureTemplateProperty(client: AnyClient): Promise<void> {
  if (templatePropertyPresent(client)) return;
  if (client.getNodeRaw(SYSTEM_CLASS_UUIDS.class) === undefined) {
    await client.createClass("class", {
      id: SYSTEM_CLASS_UUIDS.class,
      icon: SYSTEM_CLASS_ICONS.class,
    });
  }
  const have = new Set(client.listPropertySchemas().map((schema) => schema.id));
  if (!have.has(HAS_TEMPLATE_ID)) {
    await client.createPropertySchema({
      id: HAS_TEMPLATE_ID,
      name: "has-template",
      type: "object",
      multi: true,
      scope: "class",
      targetClassFilter: [SYSTEM_CLASS_UUIDS.template],
    });
  }
  const bound = new Set(
    client
      .getClassBindings(SYSTEM_CLASS_UUIDS.class)
      .map((binding) => binding.propertySchemaId),
  );
  if (!bound.has(HAS_TEMPLATE_ID)) {
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.class, HAS_TEMPLATE_ID, {
      sequence: client.getClassBindings(SYSTEM_CLASS_UUIDS.class).length,
    });
  }
}

/**
 * The templates bound to a class: the class node's AUTHORED has-template
 * values (a multi node-typed property), resolved to live template nodes in
 * authored order. Trashed/deleted targets and values pointing at non-template
 * nodes are dropped, so a stale binding never breaks the create flow. Returns
 * [] when the schema is absent (pre-seed window) — callers then behave
 * exactly as a class without templates.
 */
export function listClassTemplates(
  client: Pick<AnyClient, "getEffectiveProperties" | "getNode">,
  classId: string,
): ClientNode[] {
  const values = client
    .getEffectiveProperties(classId)
    .filter(
      (entry) =>
        entry.propertySchemaId === HAS_TEMPLATE_ID &&
        entry.source === "authored" &&
        typeof (entry.value as { nodeId?: unknown } | null)?.nodeId === "string",
    )
    .sort((a, b) => a.idx - b.idx);
  const templates: ClientNode[] = [];
  for (const entry of values) {
    const nodeId = (entry.value as { nodeId: string }).nodeId;
    const node = client.getNode(nodeId);
    if (node === undefined) continue;
    if (!node.classIds.includes(SYSTEM_CLASS_UUIDS.template)) continue;
    if (templates.some((template) => template.id === node.id)) continue;
    templates.push(node);
  }
  return templates;
}
