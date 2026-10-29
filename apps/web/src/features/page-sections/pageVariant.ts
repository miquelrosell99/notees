/**
 * pageVariant — the page variant descriptor (the main-content
 * restructure): after the curated-chrome subtraction there is NO class chrome that
 * needs slots or a hardcoded branch — the class page IS the normal page
 * path composed with variant DATA: page chrome (whose shared icon button
 * is the single icon+color edit entry) + the ClassPillsList(extends)
 * corner configuration + the class section stack. `pageVariantOf`
 * derives the descriptor from the node (modes are derived, never propped —
 * a variant prop could contradict the node; Diagram 2 of the plan).
 *
 * Shape (the SectionSpec contract composed, not forked):
 *  - `variant` — "plain" | "date-day" | "date-period" | "class".
 *  - `dayIso` / `createdPeriod` — the date variants' facts, consumed where
 *    PageView's inline day/month/year branches used to derive them (the
 *    DayPageHeader swap stays in PageHeaderChrome, driven by `dayIso`).
 *  - `cornerPills` — the corner's relation configuration: which
 *    nodes the relation holds + the add/remove mutations. Absent = the
 *    default instance-of ClassesRow corner.
 *  - `sections` / `sidebarSections` / `systemSections` — SectionSpec-shaped
 *    stacks (the data contract from components/useSectionData.ts): `key`
 *    composes the SectionSpec identity field, `render` mounts the EXISTING
 *    section component unchanged (the classview renderers are not SectionSpec
 *    read/query strategies — the descriptor's job in this slice is placement
 *    as data, not a new rendering contract). `sidebarSections` is the
 *    panelled layout's first-column stack (class:
 *    Class properties + Templates under the Metadata panel); the compact
 *    layout keeps those sections in the content stack instead.
 */

import { isSystemClassId, parseDateNodeId, rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { parentlessBlockResolverOf, parentRenderFacts } from "../../ui/renderStateLabel.js";
import { createdPeriodBounds, isoOfDateParts } from "../calendar/calendarViewUtils.js";
import { sectionEntries, type SectionEntry } from "./sectionRegistry.js";

type AnyClient = WorkspaceClient | WorkerClient;

export type PageVariantKind = "plain" | "date-day" | "date-period" | "class";

/**
 * The corner pills relation configuration: `query` is the relation's
 * current node ids, `add` / `remove` are its mutations. The class variant's
 * extends relation is the first configuration; the page corner's
 * instance-of stays the default ClassesRow until a second relation needs
 * the configuration.
 */
export interface CornerPillsConfig {
  /** The relation's current node ids (extends: the class's parent classes). */
  query: string[];
  /** Add a node to the relation (the picker's pick / create result). */
  add: (classId: string) => void;
  /** Remove a node from the relation (the pill's ×). */
  remove: (classId: string) => void;
  /** Drag-sort commit — absent for deterministic relations (extends). */
  reorder?: ((orderedIds: string[]) => void) | undefined;
  /** The "+" picker pill's visible label. */
  addLabel: string;
  /** × aria-label factory. */
  removeLabel: (label: string) => string;
  /** Picker exclusion (the extends picker excludes the class itself). */
  excludePickerNodeId: string | undefined;
  /** The pills row wrapper's chrome class (the extends row hook). */
  listClassName: string;
  /** False for deterministic relations (extends order). */
  sortable: boolean;
  /**
   * Read-only projection (no add/remove chrome) — the system-extends lock:
   * a system class's extends mapping is frozen seeded platform structure
   * (SCHEMA.md "Class properties"), so the corner renders static pills.
   */
  readOnly?: boolean;
}

/**
 * A section entry in a variant's stack — the registry's SectionEntry (the
 * `key` identity composes the SectionSpec contract), composed from the
 * registry by key list: placement is data, the render closures live in the
 * registry (sectionRegistry.ts).
 */
export type VariantSectionSpec = SectionEntry;

/** The render context a variant section receives at its mount site. */
export interface VariantSectionCtx {
  client: AnyClient;
  /**
   * The compact peek-card surface (NodeCard): every system section starts
   * COLLAPSED regardless of its surface default — the card is a glance,
   * not a workspace. Undefined/false keeps each section's own default.
   */
  sectionsStartCollapsed?: boolean | undefined;
  /** The page's node id (a class id on the class variant). */
  nodeId: string;
  /** Member/template navigation (the page's onOpenPage funnel). */
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Class navigation (extends pills, extended-by rows) — the same funnel. */
  onOpenClass?: ((classId: string) => void) | undefined;
  /**
   * Embedded surface (journal feed, calendar embed): sections render
   * read-only (the Child pages create affordance steps aside). The same
   * flag the old <SystemSections embedded> prop carried.
   */
  embedded?: boolean | undefined;
}

export interface PageVariant {
  variant: PageVariantKind;
  /** date-day: the day's ISO — drives the DayPageHeader swap + DayPageSections. */
  dayIso?: string | undefined;
  /** date-period: the Created-section bounds (month/year pages). */
  createdPeriod?: { after: string; before: string } | undefined;
  /** class: the corner's extends-pills relation configuration. */
  cornerPills?: CornerPillsConfig | undefined;
  /** Sections between the body and the date/system sections (class: classed nodes). */
  sections: VariantSectionSpec[];
  /**
   * Sections riding the panelled layout's FIRST column under the Metadata
   * panel. Only
   * rendered in the panelled layout — the compact layout keeps every section
   * in the content flow. Empty for every other variant.
   */
  sidebarSections?: VariantSectionSpec[] | undefined;
  /**
   * The page's reference family + the class variant's ahead-of-list
   * relation section (the <SystemSections/> group
   * component died by subtraction — Child pages / Backlinks / Unlinked
   * mentions are self-gating descriptor entries now, the date variants'
   * list OMITS the unlinked spec (spec absence is the date-page ruling;
   * the old runtime gate forced its count to 0), and Extended by rides
   * ahead of the family on class pages). Order is the render order.
   */
  systemSections: VariantSectionSpec[];
}

/**
 * The class variant's content-column stack — the centerpiece (Classed
 * nodes). Class properties + Templates ride the panelled layout's FIRST
 * column under the Metadata panel via `sidebarSections`;
 * the compact layout keeps them in this content stack (the session layout
 * toggle flips between the two).
 */
/**
 * The class variant's content-column stack — the centerpiece (Classed
 * nodes), composed from the registry by key list. Class properties +
 * Templates ride the panelled layout's FIRST column under the Metadata
 * panel via `sidebarSections`; the compact layout keeps them in this
 * content stack (the session layout toggle flips between the two).
 */
const CLASS_SECTIONS: VariantSectionSpec[] = sectionEntries(["classed-nodes"]);

/** The class variant's first-column stack (the panelled layout's side panel). */
const CLASS_SIDEBAR_SECTIONS: VariantSectionSpec[] = sectionEntries([
  "property-definitions",
  "parentless-role",
  "templates",
]);

/** The class variant's ahead-of-family relation section: Extended by. */
const CLASS_SYSTEM_SECTIONS: VariantSectionSpec[] = sectionEntries(["extended-by"]);

/**
 * Every page's reference family — the self-gating system sections
 * (SystemSections.tsx), as a key list: Child pages, Backlinks, Unlinked
 * mentions, in render order. Placement is data (the S5 contract); the
 * sections own their hide-when-empty gates.
 */
const PAGE_SYSTEM_SECTIONS: VariantSectionSpec[] = sectionEntries([
  "child-pages",
  "backlinks",
  "unlinked-mentions",
]);

/**
 * The date family's reference stack: the day/month/year pages' descriptor
 * OMITS the unlinked key — spec absence is the date-page ruling now. The
 * unlinked section (and its FTS count) never mounts there at all.
 */
const DATE_SYSTEM_SECTIONS: VariantSectionSpec[] = sectionEntries(
  PAGE_SYSTEM_SECTIONS.map((spec) => spec.key).filter((key) => key !== "unlinked-mentions"),
);

/**
 * The extends corner relation (the class page's corner): class.setExtends
 * REPLACE semantics — the mutations re-read the parent set at event time
 * and replace it with the delta applied. The store fails loud on cycles
 * (the applier's CycleError — the operation-level DAG check): render
 * assumes a DAG and no banner exists, so the rejection lands in `onError`
 * (the console by default), never UI.
 */
export function extendsCornerPills(
  client: AnyClient,
  classId: string,
  onError?: ((message: string) => void) | undefined,
): CornerPillsConfig {
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : "Failed to update extends";
    if (onError !== undefined) {
      onError(message);
      return;
    }
    console.warn(`[pageVariant] setClassExtends (${classId}) failed:`, message);
  };
  const replace = (nextParentIds: string[]) => {
    client.setClassExtends(classId, nextParentIds).catch(fail);
  };
  return {
    query: client.getClassParents(classId),
    add: (parentId) => replace([...client.getClassParents(classId), parentId]),
    remove: (parentId) =>
      replace(client.getClassParents(classId).filter((id) => id !== parentId)),
    sortable: false,
    // The system-extends lock (SCHEMA.md "Class properties"): a system
    // class's extends mapping is frozen seeded platform structure and the
    // applier rejects any deviation (SystemExtendsLockError), so the corner
    // renders read-only instead of advertising edits that must fail.
    readOnly: isSystemClassId(classId),
    addLabel: "Add class extension",
    removeLabel: (label) => `Remove extension ${label}`,
    excludePickerNodeId: classId,
    listClassName: "nt-extends-row",
  };
}

const NO_SECTIONS: VariantSectionSpec[] = [];

/**
 * Derive the page variant for a node (Diagram 2): a class node renders the
 * class variant data regardless of placement facts; a node that does not
 * render with document chrome has no page variant at all (the caller's
 * page-not-found guard decides); a document-chrome node parses its id at
 * day precision (date-day) or month/year precision (date-period), else
 * plain.
 */
export function pageVariantOf(client: AnyClient, nodeId: string): PageVariant {
  const node = client.getNode(nodeId);
  if (node !== undefined && node.isClass) {
    return {
      variant: "class",
      cornerPills: extendsCornerPills(client, nodeId),
      sections: CLASS_SECTIONS,
      sidebarSections: CLASS_SIDEBAR_SECTIONS,
      // Extended by rides ahead of the page's reference family — the old
      // mount order (variant system sections, then the group).
      systemSections: [...CLASS_SYSTEM_SECTIONS, ...PAGE_SYSTEM_SECTIONS],
    };
  }
  if (
    node === undefined ||
    !rendersWithDocumentChrome(node, parentRenderFacts(client, node), parentlessBlockResolverOf(client))
  ) {
    return { variant: "plain", sections: NO_SECTIONS, systemSections: PAGE_SYSTEM_SECTIONS };
  }
  const parsed = parseDateNodeId(nodeId);
  if (parsed !== null && parsed.precision === "day") {
    return {
      variant: "date-day",
      dayIso: isoOfDateParts(parsed),
      sections: NO_SECTIONS,
      systemSections: DATE_SYSTEM_SECTIONS,
    };
  }
  if (parsed !== null) {
    return {
      variant: "date-period",
      createdPeriod: createdPeriodBounds({
        year: parsed.year,
        month: parsed.month,
        precision: parsed.precision === "year" ? "year" : "month",
      }),
      sections: NO_SECTIONS,
      systemSections: DATE_SYSTEM_SECTIONS,
    };
  }
  return { variant: "plain", sections: NO_SECTIONS, systemSections: PAGE_SYSTEM_SECTIONS };
}
