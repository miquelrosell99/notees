/**
 * scopeRemedy — the guided remedy for scope rejections (owner-approved Tier 3,
 * 2026-10-26). Property scope is the sole locality authority: a schema is eligible only when the node's class closure — its
 * own classes PLUS their transitive extends-ancestors — intersects the
 * schema's scopeClassIds. When it doesn't, every surface used to be a dead
 * end: the owner had to discover the missing extends edge by hand and fire
 * class.setExtends via a script. These helpers power the one-gesture offer
 * "Let <class> extend <scope class>?" — the missing edge, submitted as a
 * UNION over the class's current parents (existing parents are never
 * silently dropped).
 */

import type { ClientPropertySchema } from "@/core/workspace-client/index.js";

import { classClosureFrom } from "./schemaEligibility.js";
import type { AnyClient } from "./shared.js";

/**
 * The schema's scope classes that the node's class closure does NOT reach —
 * the exact edges that would make the node eligible. Empty for global
 * schemas (null scopeClassIds) and for already-eligible schemas (a
 * transitive extends-ancestor satisfying the scope counts — no offer then).
 */
export function missingScopeClasses(
  client: AnyClient,
  nodeClassIds: readonly string[],
  schema: Pick<ClientPropertySchema, "scopeClassIds">,
): string[] {
  if (schema.scopeClassIds === null) return [];
  const closure = classClosureFrom(client, nodeClassIds);
  return schema.scopeClassIds.filter((classId) => !closure.has(classId));
}

/**
 * The class that RECEIVES the extends edge — the node's own first class
 * (never an ancestor; the seeds are the node's direct class assignments),
 * i.e. the class the user sees on the node. Null for a classless node: the
 * extends gesture needs a class on the node (class assignment is a
 * different gesture, out of the remedy's scope).
 */
export function nearestRemedyClass(
  _client: AnyClient,
  nodeClassIds: readonly string[],
): string | null {
  return nodeClassIds[0] ?? null;
}
