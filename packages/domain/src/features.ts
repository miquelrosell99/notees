/**
 * Workspace feature map (RESHAPED per owner directive 2026-10-04) — the
 * per-workspace feature toggles ARE the core class families:
 * tasks=task, events=event, meetings=meeting, sources=source, persons=person.
 * Each family is a seeded system class with built-in product logic; the
 * extends-children ride the base class (disabling events archives meetings
 * and birthdays with it — SYSTEM_CLASS_EXTENDS is the cascade authority).
 * Feature ids are protocol vocabulary (the WORKSPACE_FEATURES enum in
 * @notees/protocol); the op-log home is `workspace.feature.set`; the
 * derived home is the store's `workspace_feature` table (schema v10).
 *
 * Semantics (F1–F4, owner-confirmed):
 *  - Toggle-off is NEVER deletion (F3): the applier flips the family
 *    classes' registry `active` bit + class-node `is_active`, leaving
 *    `class_member_set` untouched — instances keep their class_ids and
 *    stay in the graph; pickers/search/class hubs filter the flags for
 *    free. Chrome gates read `isClassFamilyEnabled` (own feature AND every
 *    managed ancestor's — a meeting-classed surface hides when MEETINGS or
 *    EVENTS is off, a birthday-classed one when EVENTS is off).
 *  - An absent `workspace_feature` row means ENABLED (F2 — all families
 *    default ON; the empty table is the pre-toggle state, zero migration).
 *  - A `class.delete` addressed at a family's BASE class is routed to the
 *    toggle (F4): applied as a feature-disable, so the Features setting is
 *    the single archive path and the lossy plain delete (membership
 *    tombstoning) never runs on managed classes. Family CHILDREN (book,
 *    meeting, …) are NOT F4 bases — a delete on those keeps plain
 *    semantics (the owner mapped F4 to the five bases exactly).
 *  - The base system stays always-on (F1): journals (year/month/day),
 *    assets, whiteboard, the structural + admonition classes, and the
 *    classes of the DROPPED pre-reshape features (readItLater/library/
 *    collections/people → highlight, weblink, collection, agent,
 *    organization, …) — never feature-managed.
 */

import type { WorkspaceFeature } from "@notees/protocol";

import {
  SYSTEM_CLASS_UUIDS,
  systemClassAncestors,
  type SystemClassName,
} from "./seeds.js";

export interface WorkspaceFeatureSpec {
  /** The family's base system class (the F4 routing target). */
  baseClass: SystemClassName;
  /** Settings-tab label. */
  label: string;
  /** One-line "powers" description — the product logic the family powers. */
  powers: string;
}

/** The core class families (owner directive 2026-10-04). */
export const WORKSPACE_FEATURE_MAP: Record<WorkspaceFeature, WorkspaceFeatureSpec> = {
  tasks: {
    baseClass: "task",
    label: "Tasks",
    powers: "Tasks hub + checkbox gestures",
  },
  events: {
    baseClass: "event",
    label: "Events",
    powers: "The calendar day/month surfaces",
  },
  meetings: {
    baseClass: "meeting",
    label: "Meetings",
    powers: "Meeting quick-create + meeting logic",
  },
  sources: {
    baseClass: "source",
    label: "Sources",
    powers: "The source family + citation import/export",
  },
  persons: {
    baseClass: "person",
    label: "Persons",
    powers: "The people graph + contact fields",
  },
};

/**
 * Always-on system classes (F1) — never feature-managed: the base system
 * (journals year/month/day, asset, query, code, card, template, comment,
 * table, cloze, whiteboard, the admonition set) plus the classes of the
 * DROPPED pre-reshape features (highlight, weblink, collection, agent,
 * organization). The five family bases (task/event/meeting/source/person)
 * and their extends-children are NOT here — they are the toggle set.
 */
export const ALWAYS_ON_SYSTEM_CLASSES: readonly SystemClassName[] = [
  "class",
  "year",
  "month",
  "day",
  "asset",
  "query",
  "code",
  "card",
  "template",
  "comment",
  "table",
  "cloze",
  "whiteboard",
  "note",
  "tip",
  "info",
  "warning",
  "danger",
  "success",
  "quote",
  "agent",
  "organization",
  "collection",
  "highlight",
  "weblink",
];

const BASE_FEATURE_BY_CLASS = new Map<SystemClassName, WorkspaceFeature>(
  (Object.entries(WORKSPACE_FEATURE_MAP) as Array<[WorkspaceFeature, WorkspaceFeatureSpec]>).map(
    ([feature, spec]) => [spec.baseClass, feature],
  ),
);

/** The feature whose BASE class is `name`, if any. */
export function featureForBaseClass(name: SystemClassName): WorkspaceFeature | null {
  return BASE_FEATURE_BY_CLASS.get(name) ?? null;
}

let familyCache: Map<WorkspaceFeature, ReadonlyArray<SystemClassName>> | null = null;

function familyMap(): Map<WorkspaceFeature, ReadonlyArray<SystemClassName>> {
  if (familyCache !== null) return familyCache;
  const all = Object.keys(SYSTEM_CLASS_UUIDS) as SystemClassName[];
  familyCache = new Map(
    (Object.entries(WORKSPACE_FEATURE_MAP) as Array<[WorkspaceFeature, WorkspaceFeatureSpec]>).map(
      ([feature, spec]) => {
        const children = all.filter(
          (name) => name !== spec.baseClass && systemClassAncestors(name).has(spec.baseClass),
        );
        children.sort();
        return [feature, [spec.baseClass, ...children]];
      },
    ),
  );
  return familyCache;
}

/**
 * The family's full class set: the base class + its transitive
 * extends-children (deterministic, sorted after the base). Disabling the
 * family archives exactly this set.
 */
export function familyClassNames(feature: WorkspaceFeature): ReadonlyArray<SystemClassName> {
  return familyMap().get(feature)!;
}

/** Resolved UUIDs of the family's full class set (the applier's flip list). */
export function managedClassIds(feature: WorkspaceFeature): string[] {
  return familyClassNames(feature).map((name) => SYSTEM_CLASS_UUIDS[name]);
}

/**
 * F4 routing: the owning feature when `classId` is a family's BASE class,
 * else null. Children (book, meeting, birthday, …) deliberately do NOT
 * route — the owner mapped F4 to the five bases exactly.
 */
export function featureForManagedClass(classId: string): WorkspaceFeature | null {
  for (const [feature, spec] of Object.entries(WORKSPACE_FEATURE_MAP) as Array<
    [WorkspaceFeature, WorkspaceFeatureSpec]
  >) {
    if (SYSTEM_CLASS_UUIDS[spec.baseClass] === classId) return feature;
  }
  return null;
}

/**
 * Chrome gating: the features whose OFF state hides a class's
 * surfaces — its own feature when it is a family base, plus the feature of
 * every family-base ANCESTOR (systemClassAncestors walk). Empty for
 * always-on/unmanaged classes. A class's chrome shows only when EVERY
 * listed feature is enabled (a meeting surface hides when MEETINGS or
 * EVENTS is off; a birthday surface hides when EVENTS is off; book/paper/…
 * hide when SOURCES is off).
 */
export function gatingFeaturesForClass(name: SystemClassName): WorkspaceFeature[] {
  const gating: WorkspaceFeature[] = [];
  const own = featureForBaseClass(name);
  if (own !== null) gating.push(own);
  for (const ancestor of systemClassAncestors(name)) {
    const feature = featureForBaseClass(ancestor);
    if (feature !== null && !gating.includes(feature)) gating.push(feature);
  }
  return gating;
}

/** True when `name` is an always-on (not toggleable) system class (F1). */
export function isAlwaysOnSystemClass(name: SystemClassName): boolean {
  return (ALWAYS_ON_SYSTEM_CLASSES as readonly string[]).includes(name);
}

/**
 * The system-class deployment catalog (#14): seeded classes the
 * ClassCreateModal's "Deploy system class" mode offers for workspaces that
 * do not have them yet (offline-first devices, or workspaces predating the
 * seed's addition). The catalog is the FEATURE GATE for that surface — the
 * modal reads it from here and nothing else mints the list.
 *
 * Membership is deliberate: the vocabulary families and the source subtree
 * are user-facing classes worth deploying on demand; the structural base
 * (the `class` meta class, the year/month/day journals, the block-type and
 * admonition classes, cloze, assets, templates, whiteboards) is machinery
 * other flows own — it never appears here. Task is included: its property
 * family authors through ensureTaskFamily (the display/options contract
 * lives outside SYSTEM_PROPERTY_SPECS).
 */
export const DEPLOYABLE_SYSTEM_CLASSES: readonly SystemClassName[] = [
  "person",
  "organization",
  "agent",
  "source",
  "book",
  "paper",
  "article",
  "thesis",
  "document",
  "movie",
  "song",
  "tv_series",
  "conference",
  "quote",
  "event",
  "meeting",
  "birthday",
  "task",
  "collection",
  "highlight",
  "weblink",
  // #14 follow-up: the owner's list — everyday classes that were
  // missing from the catalog; definition/idea/place/project are standalone,
  // trip extends event (calendar-bound, events-toggle cascades).
  "definition",
  "idea",
  "place",
  "project",
  "trip",
];

/** True when `name` ships in the deployment catalog (#14). */
export function isDeployableSystemClass(name: SystemClassName): boolean {
  return (DEPLOYABLE_SYSTEM_CLASSES as readonly string[]).includes(name);
}
