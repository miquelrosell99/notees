/**
 * CollectionSection — the ONE section skin: the
 * collapsible chrome (NodeViewSection, the chrome primitive — the header is
 * a single <button>, so the header ROW cannot host nested controls; an
 * optional ViewToolbar rides the body top instead) around a views/
 * NodeCollection, fed by useSectionData. The lazy contract — first
 * activation, cache across switches, re-run per notification, failure keeps
 * the previous rows — lives entirely in the hook; this component is chrome
 * + the collection host. Nothing rides the skin yet — the current
 * sections convert slice by slice (their exported signatures stay frozen
 * for now); the skin lands as the single render target for the
 * SectionSpec stacks.
 *
 * The transient filter layer: `filterable` renders the FilterBar at the
 * body top and applies its FilterSpec through the hook — post-resolution,
 * pre-windowing. The count badge stays UNFILTERED (the hook's `total` is
 * the pre-filter resolved count): an active filter shows "0 of N" in the
 * bar and never hides the section. The spec is this component's state —
 * one skin instance per section view, lost on reload, nothing persisted.
 */

import { useMemo, useState, type ReactNode } from "react";

import type { AnyClient, NodeCollectionItem, NodeCollectionProps, ViewMode } from "../views/index.js";
import { NodeCollection } from "../views/index.js";

import { FilterBar } from "./FilterBar.js";
import { isFilterEmpty, EMPTY_FILTER_SPEC, type FilterBarConfig, type FilterSpec } from "./filterSpec.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { useSectionData, type SectionCtx, type SectionRowFilter } from "./useSectionData.js";
import "./CollectionSection.css";

export interface CollectionSectionProps {
  client: AnyClient;
  title: string;
  icon?: ReactNode | undefined;
  /**
   * Eager count badge (a materialized read, exempt from the lazy contract).
   * Omit to show the resolved row count instead (undefined until the first
   * resolution). Either way the badge stays UNFILTERED — an active
   * transient filter narrows the rows, never the count.
   */
  count?: number | undefined;
  /** Collapsed on first render unless overridden. */
  defaultCollapsed?: boolean;
  /** Text when the resolution came back empty — rides the collection's empty slot (inside the selected tab for hosted collections). */
  emptyText: string;
  /** The view the collection renders in. */
  viewMode: ViewMode;
  /**
   * The transient filter layer (default OFF): true renders the FilterBar
   * with its full facet set, a FilterBarConfig names the offered facets,
   * absent/false renders no bar.
   */
  filterable?: boolean | FilterBarConfig | undefined;
  /** Exactly one resolution strategy (see useSectionData). */
  read?: ((ctx: SectionCtx) => NodeCollectionItem[]) | undefined;
  query?: ((ctx: SectionCtx) => Promise<NodeCollectionItem[]>) | undefined;
  /** Optional chrome (a ViewToolbar) riding the body top, above the collection. */
  toolbar?: ReactNode | undefined;
  /** Extra NodeCollection props (groups / renderItem / readOnly / onNodeClick / …). */
  collection?: Omit<NodeCollectionProps, "client" | "items" | "viewMode"> | undefined;
  /** Hide the whole section when the count gate reads 0 (the section never vanishes behind an unresolved count). */
  hideWhenEmpty?: boolean | undefined;
}

export function CollectionSection({
  client,
  title,
  icon,
  count,
  defaultCollapsed = true,
  emptyText,
  viewMode,
  filterable = false,
  read,
  query,
  toolbar,
  collection,
  hideWhenEmpty = false,
}: CollectionSectionProps) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [filterSpec, setFilterSpec] = useState<FilterSpec>(EMPTY_FILTER_SPEC);
  const filter = useMemo<SectionRowFilter<NodeCollectionItem> | undefined>(() => {
    if (filterable === false || isFilterEmpty(filterSpec)) return undefined;
    return { spec: filterSpec, nodeOf: (item) => item.node };
  }, [filterable, filterSpec]);
  const { rows, total } = useSectionData<NodeCollectionItem[]>({
    client,
    active: expanded,
    read,
    query,
    filter,
  });
  const resolvedCount = count ?? total ?? undefined;

  if (hideWhenEmpty && resolvedCount === 0) return null;

  return (
    <NodeViewSection
      title={title}
      icon={icon}
      count={resolvedCount}
      className="nt-collection-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {filterable !== false && (
        <FilterBar
          client={client}
          value={filterSpec}
          onChange={setFilterSpec}
          config={typeof filterable === "object" ? filterable : undefined}
          matchCount={rows === null ? null : rows.length}
          totalCount={count ?? total}
        />
      )}
      {toolbar !== undefined && (
        <div className="nt-collection-section__toolbar">{toolbar}</div>
      )}
      {rows === null ? null : (
        <NodeCollection
          viewMode={viewMode}
          client={client}
          items={rows}
          {...collection}
          emptyText={emptyText}
        />
      )}
    </NodeViewSection>
  );
}
