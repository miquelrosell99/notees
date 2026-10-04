/**
 * Workspace feature map (§34.35) — the per-workspace feature toggles and
 * their managed system classes. Feature ids are protocol vocabulary (the
 * WORKSPACE_FEATURES enum in @notees/protocol — domain re-exports the map
 * shape over them); each entry maps a toggle to the system classes whose
 * surfaces it governs. The op-log home is `workspace.feature.set`; the
 * derived home is the store's `workspace_feature` table (schema v10).
 *
 * Semantics (F1–F4, owner-confirmed set):
 *  - Toggle-off is NEVER deletion (F3): the applier flips the class
 *    registry `active` bit + the class node's `is_active`, leaving
 *    `class_member_set` untouched — instances keep their class_ids and stay
 *    in the graph; pickers/search/class hubs filter the flags for free.
 *  - An absent `workspace_feature` row means ENABLED (F2 — all features
 *    default ON; the empty table is the pre-toggle state, zero migration).
 *  - A `class.delete` addressed at a managed class is routed to the toggle
 *    (F4): applied as a feature-disable, so the lossy plain delete (which
 *    tombstones every membership pair) never runs on managed classes.
 *  - Always-on structural classes are not toggleable (F1) — including
 *    `whiteboard` (both a class and a content token: embedded whiteboards in
 *    existing content must render even with the class off, so v1 of the
 *    system keeps it always-on) and `meeting` (owner ruling 2026-10-04:
 *    plain seed, §34.36 — never entered the toggle set).
 */

import type { WorkspaceFeature } from "@notees/protocol";

import { SYSTEM_CLASS_UUIDS, type SystemClassName } from "./seeds.js";

export interface WorkspaceFeatureSpec {
  /** Settings-tab label. */
  label: string;
  /** Settings-tab description (what the toggle governs). */
  description: string;
  /** The managed system classes (feature-off archives them as a unit). */
  classes: readonly SystemClassName[];
}

export const WORKSPACE_FEATURE_MAP: Record<WorkspaceFeature, WorkspaceFeatureSpec> = {
  tasks: {
    label: "Tasks",
    description: "Task management — the Task class, its status/deadline/priority family, and task chrome",
    classes: ["task"],
  },
  journals: {
    label: "Journals",
    description: "Daily, monthly, and yearly journal pages (the date chain)",
    classes: ["day", "month", "year"],
  },
  readItLater: {
    label: "Read it later",
    description: "The capture queue — weblinks and highlights",
    classes: ["weblink", "highlight"],
  },
  library: {
    label: "Library",
    description: "The bibliography source family — books, papers, articles, and their siblings",
    classes: [
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
    ],
  },
  people: {
    label: "People",
    description: "Agents, persons, and organizations",
    classes: ["agent", "person", "organization"],
  },
  collections: {
    label: "Collections",
    description: "Collection containers and their membership gestures",
    classes: ["collection"],
  },
};

/**
 * Always-on structural system classes (F1) — never feature-managed. The
 * admonition set + the structural classes + `whiteboard` (class/token
 * duality) + `meeting` (plain-seed ruling, §34.36).
 */
export const ALWAYS_ON_SYSTEM_CLASSES: readonly SystemClassName[] = [
  "class",
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
  "meeting",
];

/** Resolved managed class UUIDs of one feature, in manifest order. */
export function managedClassIds(feature: WorkspaceFeature): string[] {
  return WORKSPACE_FEATURE_MAP[feature].classes.map((name) => SYSTEM_CLASS_UUIDS[name]);
}

/** The owning feature when `classId` is a managed system class, else null. */
export function featureForManagedClass(classId: string): WorkspaceFeature | null {
  for (const [feature, spec] of Object.entries(WORKSPACE_FEATURE_MAP) as Array<
    [WorkspaceFeature, WorkspaceFeatureSpec]
  >) {
    for (const name of spec.classes) {
      if (SYSTEM_CLASS_UUIDS[name] === classId) return feature;
    }
  }
  return null;
}

/** True when `name` is an always-on (not toggleable) system class (F1). */
export function isAlwaysOnSystemClass(name: SystemClassName): boolean {
  return (ALWAYS_ON_SYSTEM_CLASSES as readonly string[]).includes(name);
}
