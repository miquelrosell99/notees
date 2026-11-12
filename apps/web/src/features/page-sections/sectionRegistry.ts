/**
 * sectionRegistry — the SectionSpec registry (phase 2 of the section-skin
 * conversion): every page section is declared ONCE as a `{ key, render }`
 * entry, and a variant's stack is a KEY LIST composed through
 * `sectionEntries`. Placement is data — adding, reordering, or omitting a
 * section edits a list of keys, never render closures (the date-page ruling
 * that omits unlinked mentions is a plain key filter). The render contract
 * stays the owner's boundary (pageVariant.ts): the closures mount the
 * EXISTING section components unchanged — the descriptor's job is placement,
 * not a new rendering contract (the data-facing SectionSpec in
 * useSectionData.ts stays unconsumed beyond its `key` identity).
 */

import { createElement, type ReactNode } from "react";

import type { VariantSectionCtx } from "./pageVariant.js";
import { ClassedNodesSection } from "../classview/lassedNodesSection.js";
import { ExtendedBySection } from "../classview/xtendedBySection.js";
import { ParentlessRoleSection } from "../classview/ParentlessRoleSection.js";
import { PropertyDefinitionsSection } from "../classview/PropertyDefinitionsSection.js";
import { TemplatesSection } from "../classview/emplatesSection.js";
import {
  BacklinksSection,
  ChildPagesSection,
  UnlinkedMentionsSection,
} from "./SystemSections.js";
import { ForwardPathSection } from "./ForwardPathSection.js";

/**
 * A registry entry — SectionSpec-shaped (the `key` identity composes the
 * SectionSpec contract) with `render` mounting the section component at the
 * variant's placement site.
 */
export interface SectionEntry {
  key: string;
  render: (ctx: VariantSectionCtx) => ReactNode;
}

/**
 * The registry: one entry per page section. Order here is NOT stack order —
 * each variant's key list owns its order; this array only declares what
 * exists.
 */
const ENTRIES: SectionEntry[] = [
  {
    key: "classed-nodes",
    render: ({ client, nodeId, onOpenPage, sectionsStartCollapsed }) =>
      createElement(ClassedNodesSection, { client, classId: nodeId, onOpenPage, sectionsStartCollapsed }),
  },
  {
    key: "property-definitions",
    render: ({ client, nodeId, sectionsStartCollapsed }) =>
      createElement(PropertyDefinitionsSection, { client, classId: nodeId, sectionsStartCollapsed }),
  },
  {
    key: "parentless-role",
    render: ({ client, nodeId, sectionsStartCollapsed }) =>
      createElement(ParentlessRoleSection, { client, classId: nodeId, sectionsStartCollapsed }),
  },
  {
    key: "templates",
    render: ({ client, nodeId, onOpenPage, sectionsStartCollapsed }) =>
      createElement(TemplatesSection, { client, classId: nodeId, onOpenPage, sectionsStartCollapsed }),
  },
  {
    key: "extended-by",
    render: ({ client, nodeId, onOpenClass, sectionsStartCollapsed }) =>
      createElement(ExtendedBySection, { client, classId: nodeId, onOpenClass, sectionsStartCollapsed }),
  },
  {
    key: "child-pages",
    render: ({ client, nodeId, onOpenPage, embedded, sectionsStartCollapsed }) =>
      createElement(ChildPagesSection, { client, pageId: nodeId, onOpenPage, embedded, sectionsStartCollapsed }),
  },
  {
    key: "backlinks",
    render: ({ client, nodeId, onOpenPage, sectionsStartCollapsed }) =>
      createElement(BacklinksSection, { client, pageId: nodeId, onOpenPage, sectionsStartCollapsed }),
  },
  {
    key: "unlinked-mentions",
    render: ({ client, nodeId, onOpenPage, sectionsStartCollapsed }) =>
      createElement(UnlinkedMentionsSection, { client, pageId: nodeId, onOpenPage, sectionsStartCollapsed }),
  },
  {
    // The first NON-query system section: the Forward path's custom read
    // (the consumer walk) lives in the component; the registry entry is the
    // same { key, render } shape — placement is data.
    key: "forward-path",
    render: ({ client, nodeId, onOpenPage, sectionsStartCollapsed }) =>
      createElement(ForwardPathSection, { client, pageId: nodeId, onOpenPage, sectionsStartCollapsed }),
  },
];

const BY_KEY = new Map(ENTRIES.map((entry) => [entry.key, entry]));

/**
 * Compose a variant's stack from a key list — the list IS the placement
 * data. An unknown key is a caller bug and fails loud (a stack never
 * silently drops a section).
 */
export function sectionEntries(keys: readonly string[]): SectionEntry[] {
  return keys.map((key) => {
    const entry = BY_KEY.get(key);
    if (entry === undefined) throw new Error(`[sectionRegistry] unknown section key: ${key}`);
    return entry;
  });
}
