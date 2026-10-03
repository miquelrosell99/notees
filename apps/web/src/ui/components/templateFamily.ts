/**
 * Template family — §34.25 T2/T3. The `has-template` system property (fixed
 * UUID in @notees/domain seeds, §34.28 #2's lesson applied: a reserved UUID is
 * dead without an author) binds a CLASS node to its template nodes
 * (node-typed, multi, `targetClassFilter: ["template"]` — SCHEMA.md
 * "Templates", owner decision D1). The `generated-from` property (D1
 * amendment, owner 2026-10-03) is instantiation PROVENANCE: every generated
 * node records its template instance-side (single node-typed, same class
 * filter, deliberately NOT class-bound — instance metadata).
 *
 * The seeded has-template spec rides the server seed (buildSeedEnvelopes
 * iterates SYSTEM_PROPERTY_SPECS), so fresh workspaces get the schema + the
 * binding to the system `class` class from boot. generated-from has no spec
 * entry (specs always seed a class binding); both schemas are self-healed
 * client-side idempotently — the ensureTaskFamily pattern — and the T3
 * surfaces call ensureTemplateFamily before reading/instantiating.
 *
 * Safe under both WorkspaceClient and WorkerClient — it composes only the
 * shared write surface (createClass / createPropertySchema / setClassProperty)
 * and sync reads (listPropertySchemas / getClassBindings / getNode /
 * getEffectiveProperties / getBacklinks), all RPC-mirrored.
 */

import { SYSTEM_CLASS_ICONS, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type {
  ClientEdge,
  ClientNode,
  ClientPropertySchema,
  EffectiveProperty,
  WorkspaceClient,
} from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

const HAS_TEMPLATE_ID = SYSTEM_PROPERTY_UUIDS.hasTemplate;
const GENERATED_FROM_ID = SYSTEM_PROPERTY_UUIDS.generatedFrom;

/** Shape guard: a node-typed property value ({ nodeId }). */
function nodeRefOf(value: unknown): string | null {
  const nodeId = (value as { nodeId?: unknown } | null)?.nodeId;
  return typeof nodeId === "string" ? nodeId : null;
}

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
  const templates: ClientNode[] = [];
  for (const binding of listClassTemplateBindings(client, classId)) {
    if (templates.some((template) => template.id === binding.node.id)) continue;
    templates.push(binding.node);
  }
  return templates;
}

/**
 * The class's AUTHORED has-template rows resolved to live template nodes,
 * carrying each row's idx (the Class View slot's unbind write targets the
 * row's slot). Stale/trashed/non-template targets drop out, like
 * listClassTemplates.
 */
export function listClassTemplateBindings(
  client: Pick<AnyClient, "getEffectiveProperties" | "getNode">,
  classId: string,
): Array<{ node: ClientNode; idx: number }> {
  const values = client
    .getEffectiveProperties(classId)
    .filter(
      (entry) =>
        entry.propertySchemaId === HAS_TEMPLATE_ID &&
        entry.source === "authored" &&
        nodeRefOf(entry.value) !== null,
    )
    .sort((a, b) => a.idx - b.idx);
  const bindings: Array<{ node: ClientNode; idx: number }> = [];
  for (const entry of values) {
    const node = client.getNode(nodeRefOf(entry.value)!);
    if (node === undefined) continue;
    if (!node.classIds.includes(SYSTEM_CLASS_UUIDS.template)) continue;
    bindings.push({ node, idx: entry.idx });
  }
  return bindings;
}

/**
 * True when the generated-from schema exists (D1 amendment). Unlike
 * has-template it is bound to NO class — instance metadata — so presence is
 * just the schema row.
 */
export function generatedFromPropertyPresent(
  client: Pick<AnyClient, "listPropertySchemas">,
): boolean {
  return client
    .listPropertySchemas()
    .some((entry: ClientPropertySchema) => entry.id === GENERATED_FROM_ID);
}

/**
 * Author the generated-from schema when missing (idempotent — safe on every
 * instantiation). Single node-typed value targeting the template class;
 * scope "object" — never class-bound, so no class.property.set row exists
 * anywhere for it.
 */
export async function ensureGeneratedFromProperty(client: AnyClient): Promise<void> {
  if (generatedFromPropertyPresent(client)) return;
  await client.createPropertySchema({
    id: GENERATED_FROM_ID,
    name: "generated-from",
    type: "object",
    multi: false,
    scope: "object",
    targetClassFilter: [SYSTEM_CLASS_UUIDS.template],
  });
}

/**
 * The full template family on first surface open (idempotent no-op once
 * present): the template class NODE self-heals at its reserved id for
 * offline-first workspaces that never got the server seed (the ensureTaskFamily
 * pattern), plus the has-template and generated-from schemas. Every T3
 * surface calls this before reading or instantiating.
 */
export async function ensureTemplateFamily(client: AnyClient): Promise<void> {
  if (client.getNodeRaw(SYSTEM_CLASS_UUIDS.template) === undefined) {
    await client.createClass("template", {
      id: SYSTEM_CLASS_UUIDS.template,
      icon: SYSTEM_CLASS_ICONS.template,
    });
  }
  await ensureTemplateProperty(client);
  await ensureGeneratedFromProperty(client);
}

/**
 * The template id recorded by a node's AUTHORED generated-from value (D1
 * amendment provenance) — null when the node was not generated from a
 * template (blank creates, the generic duplicate gesture).
 */
export function generatedFromOf(
  client: Pick<AnyClient, "getEffectiveProperties">,
  nodeId: string,
): string | null {
  const row = client
    .getEffectiveProperties(nodeId)
    .find(
      (entry: EffectiveProperty) =>
        entry.propertySchemaId === GENERATED_FROM_ID &&
        entry.source === "authored" &&
        nodeRefOf(entry.value) !== null,
    );
  return row === undefined ? null : nodeRefOf(row.value);
}

/**
 * How many nodes were generated from this template — the template's
 * property-reference backlinks via the edge index (the D1 amendment's derived
 * "generated with this template" read; instance-side storage means the
 * template node itself is never written at instantiation).
 */
export function templateInstanceCount(
  client: Pick<AnyClient, "getBacklinks">,
  templateId: string,
): number {
  return client
    .getBacklinks(templateId)
    .filter(
      (edge: ClientEdge) => edge.type === "property" && edge.verb === GENERATED_FROM_ID,
    ).length;
}
