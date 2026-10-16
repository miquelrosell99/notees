/**
 * SystemSections — the card-bottom system sections. Below the page's own
 * content, in order: the Child pages section (expanded, the create
 * affordance), then the page's references as TWO normal NodeCollection
 * sections (owner 2026-10-09, the tab strip's retirement): Backlinks and
 * Unlinked mentions each ride the shared collapsible-section chrome — the
 * NodeViewSection header IS the section header, the tab row is gone — with
 * the eager count badge, the hosted view chrome, the transient FilterBar,
 * and the lazy useSectionData contract every other section has. Each
 * section owns its hook instances and its FilterQuery (the per-view rule);
 * the date-page ruling stands — the deterministic day/month/year family
 * carries no Unlinked mentions section at all (the literal date text those
 * pages accumulate is noise, never a discovery surface) and the unlinked
 * count read (a full FTS pass) is skipped there.
 *
 * The hide-when-empty ruling covers all three system sections: each renders
 * only while its eager count reads > 0 (owner 2026-10-12 — Child pages
 * joined the ruling; its old main-surface exception retired). Backlinks
 * starts EXPANDED — its read is cheap and it is the incoming direction
 * (the old selected tab resolved on mount). Unlinked mentions starts
 * COLLAPSED — its list query is the expensive FTS pass, previously gated
 * behind the first tab switch; the collapsed start keeps that economics.
 * A collapsed section executes no query and caches its rows across a
 * collapse/expand at an unchanged version (the Section SCHEMA.md
 * contract); an expanded section re-derives per client notification.
 *
 * Unlinked mentions carry the original action pair: Promote rewrites the
 * source block's literal name match into a mention (./unlinkedRefs.ts —
 * after the write the source moves to Backlinks, the honest place for
 * it); Ignore dismisses the source device-locally, per page — device
 * state, never an op (./viewPrefs.js).
 *
 * The transient filter layer (owner 2026-10-07) rides the shared FilterBar
 * (./FilterBar.js — the same chrome the classed-nodes section renders),
 * since owner 2026-10-12 in the hosted tab bar's FAR RIGHT as the
 * collection's `tabBarTrailing` (the collapsible quick search + the
 * structured-filters toggle — one row with the tabs): one FilterQuery per section (the
 * per-view rule, component state — nothing persisted), applied
 * post-resolution/pre-windowing; the eager count badge stays UNFILTERED —
 * an active filter reads "0 of N" in the bar and never hides the section.
 *
 * The Child pages section renders only while the page has main children
 * (owner 2026-10-12 — the "always renders on the main surface" exception
 * retired; the create gesture lives in the "…" menu and the New button).
 * When it renders, the header carries the create affordance ("Add child
 * page" — the create lands IN THE PAGES ZONE and focuses the new child by
 * opening it, the section's row-click behavior; the expanded section's
 * live re-query refreshes the list, so the new row appears at once).
 * The tree opens on the Name A–Z sort (owner 2026-10-13), every sibling
 * level — the drag/position order stays one sort-button switch away.
 * Embedded feeds render the sections read-only: no create affordance, and
 * a childless feed entry hides the section as before.
 *
 * Extracted from PageView.tsx.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";

import { parseDateNodeId } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ReferenceEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { ReferenceSubtree } from "./ReferenceSubtree.js";
import { Section } from "../Section.js";
import { displayNameForSettings } from "../dateDisplay.js";
import { untitledLabelOf } from "../renderStateLabel.js";
import { useIgnoredUnlinkedRefs, writeIgnoredUnlinkedRef } from "../viewPrefs.js";
import { promoteMentionInAst } from "./unlinkedRefs.js";
import { FilterBar } from "./FilterBar.js";
import {
  EMPTY_FILTER_QUERY,
  filterQueryToGroup,
  isFilterInactive,
  quickTextOf,
  type FilterQuery,
} from "./filterQuery.js";
import { NodeCollection, groupByContainingPage } from "../views/index.js";
import type { HostedViewsConfig, NodeCollectionItem, SortMode } from "../views/index.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { useSectionData, type SectionRowFilter } from "./useSectionData.js";
import "./SystemSections.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Cycle-protection depth cap for the recursive page tree. */
const PAGE_TREE_DEPTH_CAP = 64;

/** A main node plus its main CHILDREN (inline body blocks filtered out), recursive. */
function pageTreeOf(client: AnyClient, node: ClientNode, remaining = PAGE_TREE_DEPTH_CAP): NodeCollectionItem {
  return {
    node,
    children:
      remaining <= 0
        ? []
        : client
            .getChildren(node.id)
            .filter((child) => !child.isClass && !child.isEmbedded)
            .map((child) => pageTreeOf(client, child, remaining - 1)),
  };
}

/**
 * Logseq-style references: entries grouped by their containing page (the
 * shared groupBy capability — collapsible group headers, click to open the
 * page); each row renders the referencing block's content (the block/editor
 * view), and clicking it opens the source — the block itself in focused view
 * when the edge is direct, otherwise the containing page.
 *
 * `unlinkedPageId` enables the promote/ignore action pair on every row (the
 * unlinked section only): Promote converts the literal match into a mention;
 * Ignore dismisses the source for this page, device-locally.
 *
 * The list opens on the Dates-first sort (owner 2026-10-13 — the named
 * mode): date-page groups newest → oldest, then the other pages A–Z; the
 * sort button in the hosted chrome switches it (Name A–Z / Default order).
 *
 * Always rendered by its hosts — even empty: the hosted view chrome stays
 * visible on an empty section, and `emptyText` (the section-empty line)
 * rides the collection's empty state.
 *
 * Exported for the block-level backlink gutter (SCHEMA.md:117 — the expanded
 * linked-references section beneath a block row reuses this rendering).
 */
export function ReferenceList({
  entries,
  client,
  onOpenPage,
  unlinkedPageId,
  hostedViews,
  trailing,
  emptyText,
  defaultSortMode = "dates-first",
}: {
  entries: ReferenceEntry[];
  client: AnyClient;
  onOpenPage?: ((nodeId: string) => void) | undefined;
  unlinkedPageId?: string | undefined;
  hostedViews?: HostedViewsConfig | undefined;
  /**
   * The section's chrome (its FilterBar) riding the hosted tab bar's far
   * right — forwarded as the collection's `tabBarTrailing`; renders only in
   * the hosted tab bar.
   */
  trailing?: ReactNode | undefined;
  /** The section-empty line when there is nothing to list (rides the collection's empty state). */
  emptyText?: string | undefined;
  /**
   * The list's sort default — Dates first unless the host says otherwise.
   * The page sections pass "position" while their quick search ranks the
   * pool (the ranked order leads then; the dates-first default yields
   * until the user picks a sort — the views' live-default contract).
   */
  defaultSortMode?: SortMode | undefined;
}) {
  const promote = useCallback(
    (source: ClientNode) => {
      if (unlinkedPageId === undefined) return;
      const name = client.getDisplayName(unlinkedPageId);
      if (name === null) return;
      const next = promoteMentionInAst(source.contentAst, name, unlinkedPageId);
      if (next !== null) void client.updateObject(source.id, { contentAst: next });
    },
    [client, unlinkedPageId],
  );
  /**
   * bound-verb backlinks: a linked-reference edge whose verb is a
   * bound propertySchemaId renders the schema's NAME (never the raw id) —
   * the surfaces the backlink arrived through ("supports", "cites"). Free
   * verbs never produce targeted edges (typed-link marks are targetless per
   * the deferred resolution ruling), so the badge only ever names a
   * schema; an unknown id renders raw, honestly.
   */
  const schemaNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const schema of client.listPropertySchemas()) map.set(schema.id, schema.name);
    return map;
  }, [client]);
  const items: NodeCollectionItem[] = entries.map((entry) => ({
    node: entry.source,
    meta: { containingPageId: entry.containingPageId, verb: entry.verb },
  }));
  const groups = groupByContainingPage(client, items, onOpenPage);
  return (
    <NodeCollection
      viewMode="outline"
      client={client}
      items={items}
      groups={groups}
      defaultSortMode={defaultSortMode}
      {...(hostedViews !== undefined ? { hostedViews } : {})}
      {...(trailing !== undefined ? { tabBarTrailing: trailing } : {})}
      {...(emptyText !== undefined ? { emptyText } : {})}
      renderItem={(item) => {
        const containingPageId =
          typeof item.meta?.containingPageId === "string" ? item.meta.containingPageId : undefined;
        const verb = typeof item.meta?.verb === "string" ? item.meta.verb : null;
        return (
          <>
            <Breadcrumbs
              client={client}
              nodeId={item.node.id}
              onOpenNode={onOpenPage}
              stopAfterId={containingPageId}
              excludeIds={containingPageId !== undefined ? [containingPageId] : undefined}
            />
            {verb !== null && (
              <span className="nt-ref-verb" title={`via ${schemaNameById.get(verb) ?? verb}`}>
                {schemaNameById.get(verb) ?? verb}
              </span>
            )}
            <ReferenceSubtree client={client} rootId={item.node.id} onOpenNode={onOpenPage} />
            {unlinkedPageId !== undefined && (
              <span className="nt-ref-actions">
                <button
                  type="button"
                  className="nt-ref-action"
                  aria-label={`Promote ${displayNameOf(item.node)} to a link`}
                  title="Promote to link"
                  onClick={() => promote(item.node)}
                >
                  <Icon path="mdi-link-plus" size={0.8} />
                </button>
                <button
                  type="button"
                  className="nt-ref-action"
                  aria-label={`Ignore ${displayNameOf(item.node)}`}
                  title="Ignore (this device)"
                  onClick={() => writeIgnoredUnlinkedRef(unlinkedPageId, item.node.id, true)}
                >
                  <Icon path="mdi-eye-off-outline" size={0.8} />
                </button>
              </span>
            )}
          </>
        );
      }}
    />
  );
}

/** Crumb-safe row label for the action aria labels. */
function displayNameOf(node: ClientNode): string {
  return displayNameForSettings(node) || untitledLabelOf(node);
}

/**
 * ReferenceSection — ONE of the page's reference sections (Backlinks /
 * Unlinked mentions) as a normal collapsible NodeCollection section: the
 * shared NodeViewSection chrome (title + icon + eager UNFILTERED count
 * badge) and the ReferenceList collection beneath — its hosted view chrome
 * included, the transient FilterBar riding the hosted tab bar's FAR RIGHT
 * as the collection's `trailing` (owner 2026-10-12). The lazy contract
 * lives in useSectionData — one instance per section (the per-view rule):
 * no query while collapsed, cached rows across a silent collapse/expand,
 * a re-derive per client notification while expanded. `refreshKey` carries
 * the device-only values the read closes over (the unlinked ignore list —
 * not a client notification).
 */
function ReferenceSection({
  client,
  pageId,
  title,
  icon,
  count,
  load,
  refreshKey,
  unlinkedPageId,
  sectionKey,
  emptyText,
  defaultExpanded = false,
  onOpenPage,
}: {
  client: AnyClient;
  pageId: string;
  title: string;
  icon: ReactNode;
  /** The eager UNFILTERED count (a materialized read, exempt from the lazy contract). */
  count: number;
  load: () => ReferenceEntry[];
  /** Values the read closes over that change without a client notification. */
  refreshKey?: unknown;
  /** Enables the Promote/Ignore row actions (the unlinked section only). */
  unlinkedPageId?: string | undefined;
  /** The hosted custom views' section key (per-section saved views). */
  sectionKey: HostedViewsConfig["sectionKey"];
  emptyText: string;
  /** Backlinks starts expanded (the cheap incoming-direction read); Unlinked mentions stays collapsed. */
  defaultExpanded?: boolean;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  /** The transient filter layer: this section's own FilterQuery (component state, lost on reload). */
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  const rowFilter = useMemo<SectionRowFilter<ReferenceEntry> | undefined>(() => {
    if (isFilterInactive(filterQuery)) return undefined;
    // The quick text narrows the pool by the ranked search before the
    // structured group applies — it rides the filter, not the AST.
    const group = filterQueryToGroup(filterQuery);
    return {
      group: group ?? { type: "group", logic: "and", children: [] },
      text: quickTextOf(filterQuery),
      nodeOf: (entry) => entry.source,
    };
  }, [filterQuery]);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { rows, total } = useSectionData<ReferenceEntry[]>({
    client,
    active: expanded,
    refreshKey,
    read: load,
    filter: rowFilter,
  });

  return (
    <NodeViewSection
      title={title}
      icon={icon}
      count={count}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {rows === null ? null : (
        <ReferenceList
          entries={rows}
          client={client}
          onOpenPage={onOpenPage}
          {...(unlinkedPageId !== undefined ? { unlinkedPageId } : {})}
          hostedViews={{ nodeId: pageId, sectionKey }}
          defaultSortMode={quickTextOf(filterQuery) === "" ? "dates-first" : "position"}
          trailing={
            <FilterBar
              client={client}
              layout="inline"
              value={filterQuery}
              onChange={setFilterQuery}
              matchCount={rows.length}
              totalCount={total}
            />
          }
          emptyText={emptyText}
        />
      )}
    </NodeViewSection>
  );
}

export function SystemSections({
  client,
  pageId,
  onOpenPage,
  /**
   * Embedded surface (journal feed, calendar embed): the sections render
   * read-only — no create affordance — and a childless feed entry hides
   * the Child pages section as before.
   */
  embedded = false,
}: {
  client: AnyClient;
  pageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  embedded?: boolean | undefined;
}) {
  const loadLinkedRefs = useCallback(() => client.getLinkedReferences(pageId), [client, pageId]);
  const ignored = useIgnoredUnlinkedRefs(pageId);
  // The ignore-list hook hands back a FRESH array every render — key the
  // callback (and the section's refreshKey below) on the joined value so
  // its identity stays stable between actual ignore-list changes; a
  // churning identity re-runs the resolution every render and loops on the
  // fresh-array state installs (found by the test pass).
  const ignoredKey = ignored.join(" ");
  const loadUnlinkedRefs = useCallback(() => {
    const dismissed = new Set(ignoredKey === "" ? [] : ignoredKey.split(" "));
    return client
      .getUnlinkedReferences(pageId)
      .filter((entry) => !dismissed.has(entry.source.id));
  }, [client, pageId, ignoredKey]);
  const loadChildPages = useCallback(() => client.getChildPages(pageId), [client, pageId]);

  // The eager counts ride the section badges (the backlink count is a
  // materialized read; the unlinked count its memoized count query — the
  // SystemSections precedent, so the badges know emptiness without running
  // the list queries). Date pages are the exception (owner 2026-10-09):
  // the whole deterministic day/month/year family hides the Unlinked
  // mentions section — the literal date text those pages accumulate is
  // noise, never a discovery surface — so the count reads 0 there and the
  // FTS pass it pays is skipped entirely (the journal feed renders one
  // embedded day page per entry).
  const isDatePage = parseDateNodeId(pageId) !== null;
  const backlinkCount = client.getBacklinkCount(pageId);
  const unlinkedCount = isDatePage ? 0 : client.getUnlinkedReferenceCount(pageId);
  const childPageCount = client.getChildPageCount(pageId);

  // The hide-when-empty rulings gate every system section — each hides while
  // its OWN count reads 0 (owner 2026-10-09, the tab strip's retirement:
  // the strip-level gate becomes per-section). Child pages joined the ruling
  // owner 2026-10-12 (the "always renders on the main surface" exception
  // retired — a childless page shows no Child pages section; the create
  // gesture lives in the "…" menu and the New button). AFTER every hook:
  // the component flips between null and rendered as counts change, so the
  // hook order must stay unconditional.
  const showChildPages = childPageCount > 0;
  const showBacklinks = backlinkCount > 0;
  const showUnlinked = !isDatePage && unlinkedCount > 0;
  if (!showChildPages && !showBacklinks && !showUnlinked) return null;

  return (
    <div className="nt-page-sections">
      {/* Child pages: hide-when-empty like every system section (owner
          2026-10-12); the header action still creates a child page when the
          section renders. */}
      {showChildPages && (
        <Section
          key={`child-${pageId}`}
          client={client}
          title="Child pages"
          icon={<Icon path="mdi-file-tree-outline" size={0.9} />}
          badge={childPageCount > 0 ? childPageCount : undefined}
          defaultCollapsed={false}
          action={
            embedded
              ? undefined
              : {
                  icon: "mdi-plus",
                  label: "Add child page",
                  onClick: () =>
                    void client.createObject({ parentId: pageId, isEmbedded: false }),
                }
          }
          load={loadChildPages}
          emptyText="No child pages."
          renderResults={(pages) => (
            // The reusable outline view over the read-only child-page tree
            // (rows open the page via the row click, per the outline view's
            // read-only tree path).
            <NodeCollection
              viewMode="outline"
              client={client}
              items={pages.map((child) => pageTreeOf(client, child))}
              tree
              readOnly
              hideBacklinkCount
              defaultSortMode="alphabetical"
              onNodeClick={(id) => onOpenPage?.(id)}
            />
          )}
        />
      )}
      {/* Backlinks: the incoming direction, expanded by default (its read
          is cheap; the old tab strip's selected tab resolved on mount).
          Hides while the count reads 0 — the hide-when-empty ruling covers
          every reference section. */}
      {showBacklinks && (
        <ReferenceSection
          key={`backlinks-${pageId}`}
          client={client}
          pageId={pageId}
          title="Backlinks"
          icon={<Icon path="mdi-link-variant" size={0.9} />}
          count={backlinkCount}
          load={loadLinkedRefs}
          sectionKey="linked-references"
          emptyText="No backlinks."
          defaultExpanded
          onOpenPage={onOpenPage}
        />
      )}
      {/* Unlinked mentions: collapsed by default — the list query is the
          expensive FTS pass, and the collapsed start keeps it lazy behind
          the first expand (the old unselected tab's contract). Date pages
          carry no section at all (the gate above forces the count to 0). */}
      {showUnlinked && (
        <ReferenceSection
          key={`unlinked-${pageId}`}
          client={client}
          pageId={pageId}
          title="Unlinked mentions"
          icon={<Icon path="mdi-text-search" size={0.9} />}
          count={unlinkedCount}
          load={loadUnlinkedRefs}
          refreshKey={ignoredKey}
          unlinkedPageId={pageId}
          sectionKey="unlinked-mentions"
          emptyText="No unlinked mentions."
          onOpenPage={onOpenPage}
        />
      )}
    </div>
  );
}
