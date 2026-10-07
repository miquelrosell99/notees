/**
 * pageVariant — the page variant descriptor (M13 of the main-content
 * restructure): after the M9–M12 subtraction there is NO class chrome that
 * needs slots or a hardcoded branch — the class page IS the normal page
 * path composed with variant DATA: page chrome (whose shared icon button
 * is the single icon+color edit entry, M9) + the ClassPillsList(extends)
 * corner configuration (M11) + the class section stack. `pageVariantOf`
 * derives the descriptor from the node (modes are derived, never propped —
 * a variant prop could contradict the node; Diagram 2 of the plan).
 *
 * Shape (the S2 SectionSpec contract composed, not forked):
 *  - `variant` — "plain" | "date-day" | "date-period" | "class".
 *  - `dayIso` / `createdPeriod` — the date variants' facts, consumed where
 *    PageView's inline day/month/year branches used to derive them (the
 *    DayPageHeader swap stays in PageHeaderChrome, driven by `dayIso`).
 *  - `cornerPills` — the corner's relation configuration (M11): which
 *    nodes the relation holds + the add/remove mutations. Absent = the
 *    default instance-of ClassesRow corner.
 *  - `sections` / `systemSections` — SectionSpec-shaped stacks (the data
 *    contract from components/useSectionData.ts): `key` composes the
 *    SectionSpec identity field, `render` mounts the EXISTING section
 *    component unchanged (the classview renderers are not SectionSpec
 *    read/query strategies — the descriptor's job in this slice is
 *    placement as data, not a new rendering contract).
 */

import { createElement, type ReactNode } from "react";

import { parseDateNodeId, rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { ClassedNodesSection } from "./classview/ClassedNodesSection.js";
import { ExtendedBySection } from "./classview/ExtendedBySection.js";
import { PropertyDefinitionsSection } from "./classview/PropertyDefinitionsSection.js";
import { TemplatesSection } from "./classview/TemplatesSection.js";
import { createdPeriodBounds, isoOfDateParts } from "./calendarViewUtils.js";
import type { SectionSpec } from "./useSectionData.js";

type AnyClient = WorkspaceClient | WorkerClient;

export type PageVariantKind = "plain" | "date-day" | "date-period" | "class";

/**
 * The corner pills relation configuration (M11): `query` is the relation's
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
}

/**
 * A section entry in a variant's stack — SectionSpec-shaped (the `key`
 * identity composes SectionSpec; the read/query strategies and the M3/M4
 * filter/view extensions stay in the S2 contract), with `render` mounting
 * the existing section component at the variant's placement site.
 */
export interface VariantSectionSpec extends Pick<SectionSpec, "key"> {
  render: (ctx: VariantSectionCtx) => ReactNode;
}

/** The render context a variant section receives at its mount site. */
export interface VariantSectionCtx {
  client: AnyClient;
  /** The page's node id (a class id on the class variant). */
  nodeId: string;
  /** Member/template navigation (the page's onOpenPage funnel). */
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Class navigation (extends pills, extended-by rows) — the same funnel. */
  onOpenClass?: ((classId: string) => void) | undefined;
}

export interface PageVariant {
  variant: PageVariantKind;
  /** date-day: the day's ISO — drives the DayPageHeader swap + DayPageSections. */
  dayIso?: string | undefined;
  /** date-period: the Created-section bounds (month/year pages). */
  createdPeriod?: { after: string; before: string } | undefined;
  /** class: the corner's extends-pills relation configuration. */
  cornerPills?: CornerPillsConfig | undefined;
  /** Sections between the body and the date/system sections (class: the class stack). */
  sections: VariantSectionSpec[];
  /** Sections ahead of the default <SystemSections/> (class: Extended by). */
  systemSections: VariantSectionSpec[];
}

/** The class variant's section stack — the classview renderers, unchanged. */
const CLASS_SECTIONS: VariantSectionSpec[] = [
  {
    key: "property-definitions",
    render: ({ client, nodeId }) =>
      createElement(PropertyDefinitionsSection, { client, classId: nodeId }),
  },
  {
    key: "templates",
    render: ({ client, nodeId, onOpenPage }) =>
      createElement(TemplatesSection, { client, classId: nodeId, onOpenPage }),
  },
  {
    key: "classed-nodes",
    render: ({ client, nodeId, onOpenPage }) =>
      createElement(ClassedNodesSection, { client, classId: nodeId, onOpenPage }),
  },
];

/** The class variant's ahead-of-system sections: Extended by. */
const CLASS_SYSTEM_SECTIONS: VariantSectionSpec[] = [
  {
    key: "extended-by",
    render: ({ client, nodeId, onOpenClass }) =>
      createElement(ExtendedBySection, { client, classId: nodeId, onOpenClass }),
  },
];

/**
 * The extends corner relation (the class page's corner): class.setExtends
 * REPLACE semantics — the mutations re-read the parent set at event time
 * and replace it with the delta applied. The store fails loud on cycles
 * (the applier's CycleError — M12's operation-level DAG check): render
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
    addLabel: "Add class extension",
    removeLabel: (label) => `Remove extension ${label}`,
    excludePickerNodeId: classId,
    listClassName: "nt-extends-row",
  };
}

/** The empty stacks every non-class variant declares. */
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
      systemSections: CLASS_SYSTEM_SECTIONS,
    };
  }
  if (node === undefined || !rendersWithDocumentChrome(node)) {
    return { variant: "plain", sections: NO_SECTIONS, systemSections: NO_SECTIONS };
  }
  const parsed = parseDateNodeId(nodeId);
  if (parsed !== null && parsed.precision === "day") {
    return {
      variant: "date-day",
      dayIso: isoOfDateParts(parsed),
      sections: NO_SECTIONS,
      systemSections: NO_SECTIONS,
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
      systemSections: NO_SECTIONS,
    };
  }
  return { variant: "plain", sections: NO_SECTIONS, systemSections: NO_SECTIONS };
}
