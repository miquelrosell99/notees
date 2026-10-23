/**
 * SystemSections — the page's reference family as THREE SELF-GATING
 * sections (owner 2026-10-21: the `SystemSections` group component died by
 * subtraction — 2026-10-20 retired its wrapper chrome and its all-empty
 * gate; this slice retires the component itself). Each section renders ONLY
 * while its OWN eager count reads > 0 (the hide-when-empty ruling, owner
 * 2026-10-09/10-12 — the gate lives IN the section now, the ExtendedBySection
 * pattern: an eager count read, `null` when 0, then the lazy section
 * component) and each mounts through the variant's `systemSections`
 * descriptor list (pageVariant.ts) — placement is data, there is no group
 * mount. Below the page's own content, in order: Child pages (expanded, the
 * create affordance), then the page's references as TWO normal
 * NodeCollection sections (owner 2026-10-09, the tab strip's retirement):
 * Backlinks and Unlinked mentions each ride the shared collapsible-section
 * chrome — the NodeViewSection header IS the section header, the tab row is
 * gone — with the hosted view chrome, the transient
 * FilterBar, and the lazy useSectionData contract every other section has.
 * One count semantics everywhere (displayed nodes), named exactly once
 * (owner refinement 2026-10-23 of the 2026-10-21 ruling): the hosted
 * reference sections name the number dynamically on the active tab's badge
 * and keep the header bare; a section WITHOUT hosted tabs (Child pages)
 * names it in the section-header count badge — the gates below still read
 * eager counts, now feeding the header badge too ("is there ANYTHING" +
 * "how many").
 * Each section owns its hook instances and its FilterQuery (the per-view
 * rule). The date-page ruling stands with a cleaner mechanism: the
 * deterministic day/month/year family's descriptor OMITS the unlinked
 * spec (the literal date text those pages accumulate is noise, never a
 * discovery surface) — the old runtime count-forced-to-0 gate and its
 * skipped FTS read become spec absence, so the section (and its count)
 * never mounts there at all.
 *
 * Backlinks starts EXPANDED — its read is cheap and it is the incoming
 * direction (the old selected tab resolved on mount). Unlinked mentions
 * starts COLLAPSED — its list query is the expensive FTS pass, previously
 * gated behind the first tab switch; the collapsed start keeps that
 * economics. A collapsed section executes no query and caches its rows
 * across a collapse/expand at an unchanged version (the Section SCHEMA.md
 * contract); an expanded section re-derives per client notification.
 *
 * Unlinked mentions carry the original action pair: Promote rewrites the
 * source block's literal name match into a mention (./unlinkedRefs.ts —
 * after the write the source moves to Backlinks, the honest place for
 * it); Ignore dismisses the source device-locally, per page — device
 * state, never an op (./viewPrefs.js). The transient filter layer
 * (owner 2026-10-07) rides the shared FilterBar (./FilterBar.js — the same
 * chrome the classed-nodes section renders), since owner 2026-10-12 in the
 * hosted tab bar's FAR RIGHT as the collection's `tabBarTrailing` (the
 * collapsible quick search + the structured-filters toggle — one row with
 * the tabs): one FilterQuery per section (the per-view rule, component
 * state — nothing persisted), applied post-resolution/pre-windowing; an
 * active filter reads "0 of N" in the bar and never hides the section.
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
 * Extracted from PageView.tsx; the group component subtracted 2026-10-21.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ReferenceEntry, WorkspaceClient } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { Section } from "../../ui/Section.js";
import { nodeDisplayName } from "../../ui/dateDisplay.js";
import { untitledLabelOf } from "../../ui/renderStateLabel.js";
import { useIgnoredUnlinkedRefs, writeIgnoredUnlinkedRef } from "../../ui/viewPrefs.js";
import { promoteMentionInAst } from "../collection/unlinkedRefs.js";
import { FilterBar } from "../collection/FilterBar.js";
import {
  EMPTY_FILTER_QUERY,
  filterQueryToGroup,
  isFilterInactive,
  quickTextOf,
  type FilterQuery,
} from "../collection/filterQuery.js";
import { NodeCollection, groupByContainingPage } from "../collection/index.js";
import type { HostedViewsConfig, NodeCollectionItem, SortMode } from "../collection/index.js";
import { SECTION_DEFAULT_TAB } from "../collection/SectionViewTabs.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { useSectionData, type SectionRowFilter } from "../collection/useSectionData.js";
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
 * ReferenceList — the page's references as an ORDINARY outline collection
 * (owner ruling 2026-10-21: "Backlinks should be like any other section"),
 * its rows EDITABLE (owner ruling 2026-10-23: the reference rows answer
 * content edits like the tasks hub — a content click swaps in the block
 * editor; the bullet element still owns opening the source, the block
 * itself in focused view when the edge is direct, otherwise the containing
 * page): one row per entry, children folded behind the chevron like every
 * other collection list. The Logseq-era bespoke row (a breadcrumb trail +
 * an inline editable subtree per row) is retired; the grouping by
 * containing page, the ungrouped-page-sources-first ruling (owner
 * 2026-10-20), the hosted tabs, the sort button, and the transient filter
 * layer are the shared machinery already. What a row still owns rides the
 * shared trailing-action seam: the bound-verb badge (bound-property
 * backlinks name the schema the edge arrived through, never the raw id)
 * and, on the unlinked section only, the Promote/Ignore pair.
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
    // The reference reads are scope-classed (op-lag slice 3): a source
    // edited without touching this page leaves its pooled snapshot stale —
    // each row re-reads its source through the scope-classed getNode, which
    // the source's own edit invalidates.
    node: client.getNode(entry.source.id) ?? entry.source,
    meta: { containingPageId: entry.containingPageId, verb: entry.verb },
  }));
  const { standalone, groups } = groupByContainingPage(client, items, onOpenPage);
  return (
    <NodeCollection
      viewMode="outline"
      client={client}
      items={items}
      /**
       * Editable rows (owner ruling 2026-10-23 — reference rows answer
       * content edits; an edit that removes the mention honestly moves the
       * row to the other section or out of it). `readOnly={false}` rather
       * than `editable`: this is NOT a drag-ordered editing surface, so
       * the read-time sort button must stay (an `editable` surface hides
       * it — there the sort would fight the drag order).
       */
      readOnly={false}
      groups={groups}
      ungroupedItems={standalone}
      defaultSortMode={defaultSortMode}
      onNodeClick={(id) => onOpenPage?.(id)}
      {...(hostedViews !== undefined ? { hostedViews } : {})}
      {...(trailing !== undefined ? { tabBarTrailing: trailing } : {})}
      {...(emptyText !== undefined ? { emptyText } : {})}
      trailingAction={(item) => {
        const verb = typeof item.meta?.verb === "string" ? item.meta.verb : null;
        if (verb === null && unlinkedPageId === undefined) return null;
        return (
          <>
            {verb !== null && (
              <span className="nt-ref-verb" title={`via ${schemaNameById.get(verb) ?? verb}`}>
                {schemaNameById.get(verb) ?? verb}
              </span>
            )}
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
  return nodeDisplayName(node) || untitledLabelOf(node);
}

/**
 * ReferenceSection — ONE of the page's reference sections (Backlinks /
 * Unlinked mentions) as a normal collapsible NodeCollection section: the
 * shared NodeViewSection chrome (title + icon — NO header count badge; a
 * hosted section names the count on the active tab, owner ruling
 * 2026-10-21 refined 2026-10-23) and the ReferenceList collection beneath —
 * its hosted view chrome included, the transient FilterBar riding the
 * hosted tab bar's FAR RIGHT as the collection's `trailing` (owner
 * 2026-10-12), the active
 * tab's badge naming the displayed row count. The lazy contract
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
  /**
   * The hosted tab state, lifted (owner ruling 2026-10-21): "Save as tab"
   * persists the draft as a section view and must SELECT the new tab — the
   * tab state lives here now, handed to the collection as a controlled
   * hostedViews (NodeCollection falls back to its internal state when the
   * control props are absent).
   */
  const [tab, setTab] = useState<string>(SECTION_DEFAULT_TAB);
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
          hostedViews={{ nodeId: pageId, sectionKey, selected: tab, onSelectTab: setTab }}
          defaultSortMode={quickTextOf(filterQuery) === "" ? "dates-first" : "position"}
          trailing={
            <FilterBar
              client={client}
              layout="inline"
              value={filterQuery}
              onChange={setFilterQuery}
              matchCount={rows.length}
              totalCount={total}
              viewSaver={{ client, nodeId: pageId, sectionKey, onSaved: setTab }}
            />
          }
          emptyText={emptyText}
        />
      )}
    </NodeViewSection>
  );
}

/**
 * ChildPagesSection — the page's main children as the read-only tree, ONE
 * self-gating section (owner 2026-10-21): the eager count reads first, the
 * section renders null while it reads 0 (the hide-when-empty ruling, owner
 * 2026-10-12), else the lazy <Section> mounts — the ExtendedBySection
 * pattern. The header carries the create affordance ("Add child page" —
 * the create lands IN THE PAGES ZONE, embedded feeds render read-only with
 * no action). The tree opens on the Name A–Z sort (owner 2026-10-13).
 */
export function ChildPagesSection({
  client,
  pageId,
  onOpenPage,
  /**
   * Embedded surface (journal feed, calendar embed): the section renders
   * read-only — no create affordance.
   */
  embedded = false,
}: {
  client: AnyClient;
  pageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  embedded?: boolean | undefined;
}) {
  const loadChildPages = useCallback(() => client.getChildPages(pageId), [client, pageId]);
  const childPageCount = client.getChildPageCount(pageId);
  if (childPageCount === 0) return null;
  return (
    <Section
      key={`child-${pageId}`}
      client={client}
      title="Child pages"
      icon={<Icon path="mdi-file-tree-outline" size={0.9} />}
      badge={childPageCount}
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
          showBreadcrumbs={false}
          defaultSortMode="alphabetical"
          onNodeClick={(id) => onOpenPage?.(id)}
        />
      )}
    />
  );
}

/**
 * BacklinksSection — the incoming direction, expanded by default (its read
 * is cheap; the old tab strip's selected tab resolved on mount). Self-gates
 * on the eager materialized count (null while 0 — the hide-when-empty
 * ruling covers every reference section); the count itself no longer
 * displays anywhere (owner ruling 2026-10-21) — the active tab's badge
 * names the displayed rows.
 */
export function BacklinksSection({
  client,
  pageId,
  onOpenPage,
}: {
  client: AnyClient;
  pageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const loadLinkedRefs = useCallback(() => client.getLinkedReferences(pageId), [client, pageId]);
  const backlinkCount = client.getBacklinkCount(pageId);
  if (backlinkCount === 0) return null;
  return (
    <ReferenceSection
      key={`backlinks-${pageId}`}
      client={client}
      pageId={pageId}
      title="Backlinks"
      icon={<Icon path="mdi-link-variant" size={0.9} />}
      load={loadLinkedRefs}
      sectionKey="linked-references"
      emptyText="No backlinks."
      defaultExpanded
      onOpenPage={onOpenPage}
    />
  );
}

/**
 * UnlinkedMentionsSection — collapsed by default (the list query is the
 * expensive FTS pass; the collapsed start keeps it lazy behind the first
 * expand — the old unselected tab's contract). Self-gates on the eager
 * memoized count. Carries the promote/ignore action pair (see
 * ReferenceList). The date-page ruling lives in the DESCRIPTOR now
 * (owner 2026-10-21): the date variants' systemSections omit this spec, so
 * neither the section nor its FTS count mounts there — the old runtime
 * count-forced-to-0 gate retired with the group.
 */
export function UnlinkedMentionsSection({
  client,
  pageId,
  onOpenPage,
}: {
  client: AnyClient;
  pageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const ignored = useIgnoredUnlinkedRefs(pageId);
  // The ignore-list hook hands back a FRESH array every render — key the
  // callback (and the section's refreshKey below) on the joined value so
  // its identity stays stable between actual ignore-list changes; a
  // churning identity re-runs the resolution every render and loops on the
  // fresh-array state installs (found by the test pass). Hooks run before
  // the self-gate below — the component flips between null and rendered as
  // counts change, so the hook order must stay unconditional.
  const ignoredKey = ignored.join(" ");
  const loadUnlinkedRefs = useCallback(() => {
    const dismissed = new Set(ignoredKey === "" ? [] : ignoredKey.split(" "));
    return client
      .getUnlinkedReferences(pageId)
      .filter((entry) => !dismissed.has(entry.source.id));
  }, [client, pageId, ignoredKey]);
  const unlinkedCount = client.getUnlinkedReferenceCount(pageId);
  if (unlinkedCount === 0) return null;
  return (
    <ReferenceSection
      key={`unlinked-${pageId}`}
      client={client}
      pageId={pageId}
      title="Unlinked mentions"
      icon={<Icon path="mdi-text-search" size={0.9} />}
      load={loadUnlinkedRefs}
      refreshKey={ignoredKey}
      unlinkedPageId={pageId}
      sectionKey="unlinked-mentions"
      emptyText="No unlinked mentions."
      onOpenPage={onOpenPage}
    />
  );
}
