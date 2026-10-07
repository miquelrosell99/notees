/**
 * System-class deployment (#14) — the client-side self-heal that mirrors
 * the server workspace seed (apps/server/src/seed.ts) one class at a time,
 * in the meetingFamily.ts / ensureTaskFamily precedent.
 *
 * A workspace can be missing seeded system classes it never received
 * (offline-first devices; workspaces created before a seed joined the
 * manifest). `deploySystemClass` authors ONE class idempotently at its
 * fixed seed uuid — the class node, its extends edges (ancestors deployed
 * first: an edge has nothing to attach to without the parent row), and its
 * property family from the seed manifest (SYSTEM_PROPERTY_SPECS bound to
 * the class + the SYSTEM_EXTRA_CLASS_BINDINGS rows). Every step checks
 * existence first, so re-running is a complete no-op. All existing ops —
 * nothing here mints new vocabulary.
 *
 * The `task` family is the one exception to the generic path: its schemas
 * carry the designed status options + the bullet display position, a
 * contract that lives in TASK_FAMILY_SEED and is authored by
 * ensureTaskFamily — deployment delegates to it after the class node
 * exists.
 *
 * The deployment CATALOG (which classes the ClassCreateModal offers) is
 * the domain feature gate: DEPLOYABLE_SYSTEM_CLASSES in
 * @notees/domain (features.ts) — this module never mints the list.
 */

import {
  DEPLOYABLE_SYSTEM_CLASSES,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_EXTRA_CLASS_BINDINGS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  type SystemClassName,
  type SystemPropertyName,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { ensureTaskFamily } from "./taskFamily.js";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * The seeded system classes a workspace does not have yet — the
 * ClassCreateModal's deploy catalog (#14). Read through getNodeRaw so an
 * existing class (server-seeded or previously deployed) never reappears.
 */
export function deployableSystemClasses(
  client: Pick<AnyClient, "getNodeRaw">,
): SystemClassName[] {
  return DEPLOYABLE_SYSTEM_CLASSES.filter(
    (name) => client.getNodeRaw(SYSTEM_CLASS_UUIDS[name]) === undefined,
  );
}

/**
 * Deploy one system class at its fixed seed uuid: ancestors first, then
 * the class node, then the extends edges, then the property family. A
 * complete no-op once present (including a dropped edge or binding — the
 * per-step existence checks re-author whatever is missing). The recursion
 * guard is defensive: the seed's extends graph is a DAG by construction.
 */
export async function deploySystemClass(
  client: AnyClient,
  key: SystemClassName,
  visiting: ReadonlySet<SystemClassName> = new Set(),
): Promise<string> {
  if (visiting.has(key)) {
    throw new Error(`deploySystemClass: cycle in the seed extends graph at "${key}"`);
  }
  const guard = new Set<SystemClassName>(visiting).add(key);
  const classId = SYSTEM_CLASS_UUIDS[key];

  // Ancestors first: class.setExtends needs the parent rows to exist.
  const parents = SYSTEM_CLASS_EXTENDS[key] ?? [];
  for (const parent of parents) {
    await deploySystemClass(client, parent, guard);
  }

  if (client.getNodeRaw(classId) === undefined) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[key], {
      id: classId,
      icon: SYSTEM_CLASS_ICONS[key],
    });
  }

  if (parents.length > 0) {
    const parentIds = parents.map((parent) => SYSTEM_CLASS_UUIDS[parent]);
    const current = client.getClassParents(classId);
    if (parentIds.some((id) => !current.includes(id))) {
      // Replace semantics with exactly the seeded parent set — a re-run
      // converges with the server seed.
      await client.setClassExtends(classId, parentIds);
    }
  }

  // The task family's contract (options + display) lives in
  // TASK_FAMILY_SEED, not SYSTEM_PROPERTY_SPECS — delegate.
  if (key === "task") {
    await ensureTaskFamily(client);
    return classId;
  }

  // Generic family: the manifest's specs bound to this class, in manifest
  // order (sequences continue after any existing binding rows, exactly
  // what the server seed's per-class counter does on a fresh class).
  const family = (
    Object.entries(SYSTEM_PROPERTY_SPECS) as Array<
      [SystemPropertyName, (typeof SYSTEM_PROPERTY_SPECS)[SystemPropertyName]]
    >
  ).filter(([, spec]) => spec !== undefined && spec.bindTo === key);
  if (family.length > 0) {
    const have = new Set(client.listPropertySchemas().map((schema) => schema.id));
    for (const [name, spec] of family) {
      if (have.has(SYSTEM_PROPERTY_UUIDS[name])) continue;
      await client.createPropertySchema({
        id: SYSTEM_PROPERTY_UUIDS[name],
        name: SYSTEM_PROPERTY_DISPLAY_NAMES[name],
        type: spec!.type,
        multi: spec!.multi ?? false,
        scope: "class",
        ...(spec!.options !== undefined ? { options: spec!.options } : {}),
        ...(spec!.targetClassFilter !== undefined
          ? { targetClassFilter: spec!.targetClassFilter.map((c) => SYSTEM_CLASS_UUIDS[c]) }
          : {}),
      });
    }
    const bound = new Set(
      client.getClassBindings(classId).map((binding) => binding.propertySchemaId),
    );
    let sequence = client.getClassBindings(classId).length;
    for (const [name, spec] of family) {
      const schemaId = SYSTEM_PROPERTY_UUIDS[name];
      if (bound.has(schemaId)) continue;
      await client.setClassProperty(classId, schemaId, {
        sequence: sequence++,
        ...(spec!.defaultValue !== undefined ? { defaultValue: spec!.defaultValue } : {}),
      });
    }
  }

  // The manifest's extra binding rows for this class (an extends-child
  // re-binding an inherited schema so class-local binding reads see it —
  // the birthday→eventDate shape).
  for (const extra of SYSTEM_EXTRA_CLASS_BINDINGS) {
    if (extra.bindTo !== key) continue;
    const bound = client
      .getClassBindings(classId)
      .some((binding) => binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS[extra.property]);
    if (bound) continue;
    await client.setClassProperty(classId, SYSTEM_PROPERTY_UUIDS[extra.property], {
      sequence: extra.sequence,
    });
  }

  return classId;
}

/**
 * Heal the weblink→source extension on EXISTING workspaces (the owner
 * ruling that made the web link a source-family class). The seed map
 * carries the edge, so NEW workspaces receive it from the server seed;
 * a workspace that already has the weblink class but predates the edge
 * materializes it here — `deploySystemClass` is existence-checked per
 * step (ancestors first: the source root, then the class node, the edge,
 * the url family), so a converged workspace is a complete no-op and a
 * re-run converges by idempotence.
 *
 * Declaration-first, the meetingFamily precedent: nothing calls this
 * automatically — configure now, wire later.
 */
export async function ensureWeblinkExtendsSource(client: AnyClient): Promise<void> {
  const current = client.getClassParents(SYSTEM_CLASS_UUIDS.weblink);
  if (current.includes(SYSTEM_CLASS_UUIDS.source)) return;
  await deploySystemClass(client, "weblink");
}
