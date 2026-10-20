/**
 * schemaEligibility — the client-side scope walk. `scopeClassIds` is the SOLE locality authority: a schema is
 * eligible for a node when it is global (null list) or the node's class
 * closure — its own classes PLUS their transitive extends-ancestors (R2,
 * the same closure binding resolution walks) — intersects the list.
 *
 * This mirrors the store's write-time/applier enforcement (R3: property.set
 * fails loud on an ineligible node) for PICKER surfaces: the add-property
 * candidate list filters ineligible schemas out BEFORE the write, and the
 * effective read's `eligible: false` tag (R4) drives the panel's honest
 * broken-style rendering. Never retroactive: authored rows on ineligible
 * schemas survive and render tagged.
 */

import type { ClientNode, ClientPropertySchema } from "@/core/workspace-client/index.js";

import type { AnyClient } from "./shared.js";

/**
 * The class closure of a node: its own class ids plus every transitive
 * extends-ancestor (BFS over client.getClassParents, cycle-guarded).
 * Unknown class ids pass through unchanged (a dangling scope entry still
 * matches a node that carries the id directly).
 */
export function classClosureOf(client: AnyClient, node: ClientNode): Set<string> {
  const closure = new Set<string>(node.classIds);
  const queue = [...node.classIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of client.getClassParents(current)) {
      if (!closure.has(parent)) {
        closure.add(parent);
        queue.push(parent);
      }
    }
  }
  return closure;
}

/**
 * True when the schema MAY be carried by the node: global (null
 * scopeClassIds) or the node's class closure intersects the scope list.
 */
export function isSchemaEligibleForNode(
  client: AnyClient,
  schema: Pick<ClientPropertySchema, "scopeClassIds">,
  node: ClientNode,
): boolean {
  if (schema.scopeClassIds === null) return true;
  const closure = classClosureOf(client, node);
  return schema.scopeClassIds.some((classId) => closure.has(classId));
}

/**
 * The add-property candidate set: schemas whose scope includes the node.
 * Global schemas always ride; local ones only when the node's class closure
 * reaches one of the scope classes.
 */
export function eligibleSchemasForNode(
  client: AnyClient,
  schemas: ClientPropertySchema[],
  node: ClientNode,
): ClientPropertySchema[] {
  return schemas.filter((schema) => isSchemaEligibleForNode(client, schema, node));
}

/**
 * The CLASS-context eligibility (the class page's add-property popup,
 * proposal S4): global rides; a local schema is offered when the class
 * ITSELF or any of its transitive extends-ancestors is in the scope list
 * (the classClosureOf walk has no class node to start from, so the closure
 * seeds with the class id directly).
 */
export function isSchemaEligibleForClass(
  client: AnyClient,
  schema: Pick<ClientPropertySchema, "scopeClassIds">,
  classId: string,
): boolean {
  if (schema.scopeClassIds === null) return true;
  const closure = new Set<string>([classId]);
  const queue = [classId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of client.getClassParents(current)) {
      if (!closure.has(parent)) {
        closure.add(parent);
        queue.push(parent);
      }
    }
  }
  return schema.scopeClassIds.some((id) => closure.has(id));
}
