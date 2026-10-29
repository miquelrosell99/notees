/**
 * CollectionSection — the ONE section skin: the
 * collapsible chrome (NodeViewSection, the chrome primitive — the header is
 * a single <button>, so the header ROW cannot host nested controls; an
 * optional ViewToolbar rides the body top instead) around a views/
 * NodeCollection, fed by useSectionData. The lazy contract — first
 * activation, cache across switches, re-run per notification, failure keeps
 * the previous rows — lives entirely in the hook; this component is chrome
 * + the collection host. The collection-backed sections convert onto this
 * skin slice by slice; the bespoke-content sections (Comments,
 * VersionHistory, …) stay on NodeViewSection directly — the skin's body is
 * a NodeCollection, which they do not have.
 *
 * The transient filter layer: `filterable` renders the NodeCollectionToolbar —
 * at the body top for an UN-hosted collection; as the hosted tab bar's
 * far-right cluster (inline, the collapsible quick search FIRST — the
 * owner's register composed HERE: toolbar → ViewChromeSlot → the host's
 * `collection.toolbarContent` extras; the "Save as tab" wiring rides when
 * the hosted views are controlled) when the collection props carry
 * `hostedViews` — and applies its FilterQuery through the hook —
 * post-resolution, pre-windowing. The count rides the hosted tab bar's
 * active-tab badge (displayed rows), never a section-header number, unless
 * the section is UN-hosted (the header badge names it there — one count
 * named exactly once); the gate below stays UNFILTERED (the hook's `total`
 * is the pre-filter resolved count): an active filter shows "0 of N" in the
 * bar and never hides the section. The query is this component's state —
 * one skin instance per section view, lost on reload, nothing persisted;
 * hosts observe it through `onFilterChange` (the live sort-flip: ranked
 * quick text leads until the user picks a sort).
 */

import { useMemo, useState, type ReactNode } from "react";

import type { AnyClient, NodeCollectionItem, NodeCollectionProps, ViewMode } from "./index.js";
import { NodeCollection } from "./index.js";

import { NodeCollectionToolbar } from "./NodeCollectionToolbar.js";
import {
  EMPTY_FILTER_QUERY,
  filterQueryToGroup,
  isFilterInactive,
  quickTextOf,
  type NodeCollectionToolbarConfig,
  type FilterQuery,
} from "./filterQuery.js";
import { NodeViewSection, type NodeViewSectionAction } from "../page-sections/NodeViewSection.js";
import { ViewChromeSlot } from "./viewChrome.js";
import { useSectionData, type SectionCtx, type SectionRowFilter } from "./useSectionData.js";
import "./CollectionSection.css";

export interface CollectionSectionProps {
  client: AnyClient;
  title: string;
  icon?: ReactNode | undefined;
  /**
   * Eager count for the hide-when-empty gate (a materialized read, exempt
   * from the lazy contract). Omit to gate on the resolved row count instead
   * (undefined until the first resolution). Either way the gate stays
   * UNFILTERED — an active transient filter narrows the rows, never the
   * gate (a hosted skin names the count on the active tab's badge, never
   * the header — refined 2026-10-23).
   */
  count?: number | undefined;
  /** Collapsed on first render unless overridden. */
  defaultCollapsed?: boolean;
  /** Text when the resolution came back empty — rides the collection's empty slot (inside the selected tab for hosted collections). */
  emptyText: string;
  /** The view the collection renders in. */
  viewMode: ViewMode;
  /**
   * The transient filter layer (default OFF): true renders the NodeCollectionToolbar
   * with its full facet set, a NodeCollectionToolbarConfig names the offered facets,
   * absent/false renders no bar.
   */
  filterable?: boolean | NodeCollectionToolbarConfig | undefined;
  /** Exactly one resolution strategy (see useSectionData). */
  read?: ((ctx: SectionCtx) => NodeCollectionItem[]) | undefined;
  query?: ((ctx: SectionCtx) => Promise<NodeCollectionItem[]>) | undefined;
  /** Optional chrome (a ViewToolbar) riding the body top, above the collection. */
  toolbarContent?: ReactNode | undefined;
  /** Extra NodeCollection props (groups / renderItem / readOnly / onNodeClick / …). */
  collection?: Omit<NodeCollectionProps, "client" | "items" | "viewMode"> | undefined;
  /** Hide the whole section when the count gate reads 0 (the section never vanishes behind an unresolved count). */
  hideWhenEmpty?: boolean | undefined;
  /** The header's far-right icon-only action (a section-scoped create affordance). */
  action?: NodeViewSectionAction | undefined;
  /** Headerless mount (the block-backlink card) — the chrome renders no header row. */
  hideHeader?: boolean | undefined;
  /** Re-run the resolution when the key changes (the unlinked ignore list, the created-period bounds). */
  refreshKey?: string | undefined;
  /** Resolve from mount instead of first expand (the Created contract — the query IS the count). */
  resolveOnMount?: boolean | undefined;
  /** Observe the transient FilterQuery (the live sort-flip: ranked quick text leads until the user picks a sort). */
  onFilterChange?: ((query: FilterQuery) => void) | undefined;
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
  toolbarContent,
  collection,
  hideWhenEmpty = false,
  action,
  hideHeader = false,
  refreshKey,
  resolveOnMount = false,
  onFilterChange,
}: CollectionSectionProps) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  // Hosts observe the transient query (the live sort-flip) — one setter
  // paths both the state and the report.
  const handleFilterChange = (query: FilterQuery) => {
    setFilterQuery(query);
    onFilterChange?.(query);
  };
  const filter = useMemo<SectionRowFilter<NodeCollectionItem> | undefined>(() => {
    if (filterable === false || isFilterInactive(filterQuery)) return undefined;
    // The quick text rides the filter ALONGSIDE the structured group — the
    // hook narrows the pool by the ranked search (membership AND order)
    // before the group applies; it is never an AST condition.
    const group = filterQueryToGroup(filterQuery);
    return {
      group: group ?? { type: "group", logic: "and", children: [] },
      text: quickTextOf(filterQuery),
      nodeOf: (item) => item.node,
    };
  }, [filterable, filterQuery]);
  const { rows, total } = useSectionData<NodeCollectionItem[]>({
    client,
    active: resolveOnMount || expanded,
    read,
    query,
    filter,
    ...(refreshKey !== undefined ? { refreshKey } : {}),
  });
  const resolvedCount = count ?? total ?? undefined;

  if (hideWhenEmpty && resolvedCount === 0) return null;

  // The hosted ruling: on a hosted collection the chrome
  // rides the tab bar's far right — never a body-top row above the tabs.
  const hosted = collection?.hostedViews !== undefined;
  const hostedViews = collection?.hostedViews;
  // The "Save as tab" wiring rides only when the host LIFTED the tab state
  // (controlled hosted views) — the saver's onSaved is the host's select.
  const hostedControlled =
    hostedViews !== undefined &&
    hostedViews.selected !== undefined &&
    hostedViews.onSelectTab !== undefined;
  const filterConfig = typeof filterable === "object" ? filterable : undefined;

  return (
    <NodeViewSection
      title={title}
      icon={icon}
      className="nt-collection-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
      {...(action !== undefined ? { action } : {})}
      {...(hideHeader ? { hideHeader: true } : {})}
      // One count named exactly once: the hosted tab's badge names it
      // there; the header badge names it only on UN-hosted sections.
      {...(!hosted && count !== undefined ? { count } : {})}
    >
      {filterable !== false && !hosted && (
        <NodeCollectionToolbar
          client={client}
          value={filterQuery}
          onChange={handleFilterChange}
          config={filterConfig}
          matchCount={rows === null ? null : rows.length}
          totalCount={count ?? total}
        />
      )}
      {toolbarContent !== undefined && (
        <div className="nt-collection-section__toolbar">{toolbarContent}</div>
      )}
      {rows === null ? null : (
        <NodeCollection
          viewMode={viewMode}
          client={client}
          items={rows}
          {...collection}
          {...(filterable !== false && hosted
            ? {
                // The owner's register, composed in ONE place (viewChrome.tsx):
                // the toolbar with its quick search FIRST, then the
                // view-chrome slot, then the host's extras. The structured
                // panel portals into the bar's full-width seat beneath the
                // row, so nothing on the row moves when it opens.
                toolbarContent: (setSlot) => (
                  <>
                    <NodeCollectionToolbar
                      client={client}
                      layout="inline"
                      value={filterQuery}
                      onChange={handleFilterChange}
                      config={filterConfig}
                      matchCount={rows.length}
                      totalCount={count ?? total}
                      {...(hostedControlled
                        ? {
                            viewSaver: {
                              client,
                              nodeId: hostedViews.nodeId,
                              sectionKey: hostedViews.sectionKey,
                              onSaved: hostedViews.onSelectTab!,
                            },
                          }
                        : {})}
                    />
                    <ViewChromeSlot slotRef={setSlot} />
                    {collection?.toolbarContent}
                  </>
                ),
              }
            : {})}
          emptyText={emptyText}
        />
      )}
    </NodeViewSection>
  );
}
