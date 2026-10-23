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
 * existence first, so re-running is a complete no-op — and the binding
 * steps check the REGISTRY rows only (getRegistryBindings), never the
 * seed-spec fallback read: the fallback makes a class LOOK bound while no
 * class_property row exists, which used to defeat this self-heal entirely.
 * All existing ops — nothing here mints new vocabulary.
 *
 * The `task` family is the one exception to the generic path: its schemas
 * carry the designed status options + the bullet display position, a
 * contract that lives in TASK_FAMILY_SEED and is authored by
 * ensureTaskFamily — deployment delegates to it after the class node
 * exists.
 *
 * The deployment CATALOG (which classes the gallery offers, owner ruling
 * 2026-10-22) is this module's `gallerySections` — the domain supplies the
 * seed manifest + the locked set; this module never mints new vocabulary.
 */

import {
  featureForBaseClass,
  LOCKED_SYSTEM_CLASSES,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_DESCRIPTIONS,
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

import type { WorkspaceFeature } from "@notees/protocol";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { ensureTaskFamily } from "./taskFamily.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Set-equality over a stored schema scope (null = global) and the seeded scope. */
function scopeEquals(stored: string[] | null, seeded: string[] | null): boolean {
  if (stored === null || seeded === null) return stored === seeded;
  return stored.length === seeded.length && stored.every((id) => seeded.includes(id));
}

/**
 * Deploy one system class at its fixed seed uuid: ancestors first, then
 * the class node, then the extends edges, then the property family. A
 * complete no-op once present (including a dropped edge or binding — the
 * per-step existence checks re-author whatever is missing). The recursion
 * guard is defensive: the seed's extends graph is a DAG by construction.
 *
 * Enable semantics (owner ruling 2026-10-22, the classes-gallery batch):
 * picking a class in the gallery ENABLES it. A family base picked while
 * its feature toggle is off writes `workspace.feature.set {enabled: true}`
 * FIRST (the F4 inverse — the toggle derivation revives the whole family,
 * membership rides); any other archived seed is un-archived with
 * `object.update {active: true}` after the rows exist. Disable is the
 * delete gesture's routing (never this helper).
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

  // The F4 inverse: a family base deploy ENABLES its feature — the toggle
  // derivation archives/revives the whole family, so a disabled family
  // revives with this one write (the class rows below land active).
  const ownFeature = featureForBaseClass(key);
  if (ownFeature !== null && !client.isFeatureEnabled(ownFeature)) {
    await client.setFeatureEnabled(ownFeature, true);
  }

  if (client.getNodeRaw(classId) === undefined) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[key], {
      id: classId,
      icon: SYSTEM_CLASS_ICONS[key],
    });
  }

  // Un-archive an archived seed (the gallery's enable pick). The family
  // rows were revived by the toggle derivation above; this covers every
  // other archived class (and is a no-op when the bit already stands).
  if (client.getNodeRaw(classId)?.isActive === false) {
    await client.updateObject(classId, { active: true });
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

  // Generic family: the manifest's specs bound to this class (binding rows
  // carry no order — sequence retired 2026-10-21). The existence check reads
  // the REGISTRY only (getRegistryBindings):
  // getClassBindings read-synthesizes the seed-spec fallback rows, so a
  // workspace whose binding rows were never authored would LOOK bound
  // through that read and the self-heal would author nothing — the ClassView
  // renders configured while the registry-only effective-properties read
  // sees no bindings. Own rows only: an inherited binding is not this
  // class's row, and the seeded shape binds every spec on its own class.
  const family = (
    Object.entries(SYSTEM_PROPERTY_SPECS) as Array<
      [SystemPropertyName, (typeof SYSTEM_PROPERTY_SPECS)[SystemPropertyName]]
    >
  ).filter(([, spec]) => spec !== undefined && spec.bindTo === key);
  if (family.length > 0) {
    const existing = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
    for (const [name, spec] of family) {
      const schemaId = SYSTEM_PROPERTY_UUIDS[name];
      // The seeded scope for this spec: global (the scope-audit flips — url,
      // the task family) unless the spec stays a family-identity field.
      const seededScope = spec!.global === true ? null : [classId];
      const stored = existing.get(schemaId);
      if (stored === undefined) {
        await client.createPropertySchema({
          id: schemaId,
          name: SYSTEM_PROPERTY_DISPLAY_NAMES[name],
          type: spec!.type,
          multi: spec!.multi ?? false,
          // Scoped to this class unless the spec is marked `global` (owner
          // ruling 2026-10-20, the seed-scope audit — the url seed) — the
          // binding rows below land either way (bindings are per-class config).
          ...(seededScope === null ? {} : { scopeClassIds: seededScope }),
          // The spec's default is SCHEMA-level (owner ruling 2026-10-20 — one
          // global default per property, the Logseq shape).
          ...(spec!.defaultValue !== undefined ? { defaultValue: spec!.defaultValue } : {}),
          ...(spec!.options !== undefined ? { options: spec!.options } : {}),
          ...(spec!.targetClassFilter !== undefined
            ? { targetClassFilter: spec!.targetClassFilter.map((c) => SYSTEM_CLASS_UUIDS[c]) }
            : {}),
        });
      } else if (!scopeEquals(stored.scopeClassIds, seededScope)) {
        // Pre-ruling drift (owner 2026-10-22: url bound to source now — a
        // stored url schema still scoped [web_page] would make the family
        // base's binding dead config, R5 rejects it): converge the scope to
        // the seed BEFORE the binding row below (the offline-first twin of
        // scripts/migrate-seed-scope-flips.mts).
        await client.updatePropertySchema(schemaId, { scopeClassIds: seededScope });
      }
    }
    const registry = client.getRegistryBindings(classId);
    const bound = new Set(registry.map((binding) => binding.propertySchemaId));
    for (const [name, spec] of family) {
      const schemaId = SYSTEM_PROPERTY_UUIDS[name];
      if (bound.has(schemaId)) continue;
      await client.setClassProperty(classId, schemaId, {});
    }
  }

  // The manifest's extra binding rows for this class (an extends-child
  // re-binding an inherited schema so class-local binding reads see it —
  // the birthday→eventDate shape). Registry-only check here too: birthday
  // inherits event's eventDate row once the parent is deployed, and an
  // extends-aware check would mistake that inheritance for the class-local
  // row the calendar quick-create eligibility walk reads.
  for (const extra of SYSTEM_EXTRA_CLASS_BINDINGS) {
    if (extra.bindTo !== key) continue;
    const bound = client
      .getRegistryBindings(classId)
      .some((binding) => binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS[extra.property]);
    if (bound) continue;
    await client.setClassProperty(classId, SYSTEM_PROPERTY_UUIDS[extra.property], {});
  }

  return classId;
}

/**
 * Heal the web_page→source extension on EXISTING workspaces (the owner
 * ruling that made the web page a source-family class). The seed map
 * carries the edge, so NEW workspaces receive it from the server seed;
 * a workspace that already has the web_page class but predates the edge
 * materializes it here — `deploySystemClass` is existence-checked per
 * step (ancestors first: the source root, then the class node, the edge,
 * the url family), so a converged workspace is a complete no-op and a
 * re-run converges by idempotence.
 *
 * Declaration-first, the meetingFamily precedent: nothing calls this
 * automatically — configure now, wire later.
 */
export async function ensureWeblinkExtendsSource(client: AnyClient): Promise<void> {
  const current = client.getClassParents(SYSTEM_CLASS_UUIDS.web_page);
  if (current.includes(SYSTEM_CLASS_UUIDS.source)) return;
  await deploySystemClass(client, "web_page");
}

// --- the classes gallery (owner ruling 2026-10-22) --------------------------------
//
// The class-creation entry point is a Capacities-style gallery: a card grid
// of the system classes the workspace does not have ENABLED, grouped in
// sections, where picking a card ENABLES the class (deploySystemClass — the
// F4 inverse for family bases, un-archive for archived seeds). Locked
// classes never appear (un-removable platform structure); enabled classes
// are managed on their class pages, not here.

/** Section grouping for the gallery card grid (presentation only). */
const GALLERY_SECTIONS: Array<{ id: string; title: string; members: SystemClassName[] }> = [
  {
    id: "people",
    title: "People",
    members: ["person", "organization", "agent"],
  },
  {
    id: "sources",
    title: "Sources",
    members: ["source", "book", "journal_article", "thesis", "document", "web_page", "conference"],
  },
  {
    id: "events-tasks",
    title: "Events & tasks",
    members: ["event", "meeting", "birthday", "trip", "task"],
  },
  {
    id: "knowledge",
    title: "Knowledge",
    members: [
      "quote",
      "definition",
      "idea",
      "project",
      "place",
      "collection",
      "highlight",
      "card",
      "cloze",
      "note",
      "tip",
      "info",
      "warning",
      "danger",
      "success",
    ],
  },
  {
    id: "media",
    title: "Media",
    members: ["film", "song", "tv_series"],
  },
  {
    id: "more",
    title: "More",
    members: ["whiteboard"],
  },
];

const LOCKED_SET: ReadonlySet<SystemClassName> = new Set(LOCKED_SYSTEM_CLASSES);

export interface GalleryEntry {
  key: SystemClassName;
  /** False when the class node exists but is archived (pick re-enables). */
  missing: boolean;
}

export interface GallerySection {
  id: string;
  title: string;
  entries: GalleryEntry[];
}

/**
 * The gallery's catalog: every non-locked system class the workspace does
 * not have enabled — the node missing entirely, or present but archived
 * (the gallery's disabled state). Enabled classes (node exists, active)
 * are managed on their class pages and never listed. Read through
 * getNodeRaw; the modal re-reads on every render so a pick drops the card
 * out of the grid.
 */
export function gallerySections(
  client: Pick<AnyClient, "getNodeRaw">,
): GallerySection[] {
  const offered = new Set<SystemClassName>();
  const sections: GallerySection[] = [];
  for (const section of GALLERY_SECTIONS) {
    const entries: GalleryEntry[] = [];
    for (const key of section.members) {
      if (LOCKED_SET.has(key) || offered.has(key)) continue;
      offered.add(key);
      const node = client.getNodeRaw(SYSTEM_CLASS_UUIDS[key]);
      if (node !== undefined && node.isActive) continue;
      entries.push({ key, missing: node === undefined });
    }
    if (entries.length > 0) sections.push({ id: section.id, title: section.title, entries });
  }
  return sections;
}

/** The card text pair (display name + one-line description). */
export function galleryCardText(key: SystemClassName): { label: string; description: string } {
  return {
    label: SYSTEM_CLASS_DISPLAY_NAMES[key],
    description: SYSTEM_CLASS_DESCRIPTIONS[key],
  };
}

/**
 * Enable one ARCHIVED system class (the picker's dimmed Enable row) — the
 * gallery pick semantics for a class whose node already exists: a family
 * base writes the toggle's `{enabled: true}` (the F4 inverse — the toggle
 * derivation revives the whole family's rows); any other archived class
 * un-archives (`object.update {active: true}`). The minimal seam (no
 * deploy/ensure — the node exists, only its bit is off).
 */
export interface EnableArchivedClient {
  isFeatureEnabled?(feature: string): boolean;
  setFeatureEnabled?(feature: WorkspaceFeature, enabled: boolean): Promise<void>;
  updateObject(id: string, fields: { active?: boolean }): Promise<void>;
}

export async function enableArchivedSystemClass(
  client: EnableArchivedClient,
  key: SystemClassName,
): Promise<void> {
  const feature = featureForBaseClass(key);
  // Absent read / absent writer = enabled / best-effort (minimal seams):
  // a family base with the toggle off goes through the F4 inverse when the
  // toggle write is available; the unarchive below is the catch-all.
  if (
    feature !== null &&
    client.setFeatureEnabled !== undefined &&
    client.isFeatureEnabled?.(feature) === false
  ) {
    await client.setFeatureEnabled(feature, true);
    return;
  }
  await client.updateObject(SYSTEM_CLASS_UUIDS[key], { active: true });
}
