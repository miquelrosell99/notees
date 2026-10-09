/**
 * SystemSections — the card-bottom system sections. Below the page's own
 * content: the Child pages section (expanded) stays stacked as before; only
 * the REFERENCES rework rides the tab strip (owner 2026-10-06, the
 * Capacities-style layout): ONE tab bar in the old references-tab slot —
 * Backlinks and Unlinked mentions (renamed from "unlinked references") —
 * always showing both tabs even when empty, EXCEPT on date pages (owner
 * 2026-10-09): the deterministic day/month/year family carries no Unlinked
 * mentions tab at all — the literal date text those pages accumulate is
 * noise, never a discovery surface — and the unlinked count read (a full
 * FTS pass) is skipped there. The tab label carries the eager
 * count; a tab's list query runs lazily on its first activation (the
 * SCHEMA.md lazy contract), the results cache across tab switches, and a
 * live notification re-runs the loaded tabs' queries: the tab caches
 * ride useSectionData — one hook instance per tab (the per-view rule),
 * keepFresh carrying the loaded-tabs re-derive contract. The tabbed panels
 * render headerless — the tab IS the section header (no duplicated
 * tabs-plus-section-headers chrome).
 *
 * The workspace Activity feed left the stack: it renders in the
 * page chrome's context column now — the `withActivity` prop and its branch
 * are gone; this component's contract is Child pages + the backlinks strip.
 *
 * Unlinked mentions carry the original action pair:
 * Promote rewrites the source block's literal name match into a mention
 * (./unlinkedRefs.ts — after the write the source moves to Backlinks, the
 * honest place for it); Ignore dismisses the source device-locally, per
 * page — device state, never an op (./viewPrefs.js).
 *
 * The transient filter layer (owner 2026-10-07; reworked 2026-10-09): both
 * tabs are filterable — the chrome rides the TAB ROW itself, far right: an
 * icon-only magnifier folds/unfolds the quick-search field, the
 * structured-filters toggle opens the query builder in a full-width region
 * BELOW the row (in-flow, never an overlay). The chrome is STRIP-level —
 * it survives a tab switch and binds to the ACTIVE tab's FilterQuery,
 * which each tab still owns (component state — a switch never leaks a
 * filter across tabs, nothing persisted; an open builder edits whichever
 * tab is active). The query filters the tab's resolved rows
 * post-resolution/pre-windowing; the eager counts on the tab labels stay
 * UNFILTERED — an active filter reads "0 of N" in the chrome and never
 * empties the tab away.
 *
 * The Child pages section renders when the page has main children OR the
 * surface can create them: an empty main-surface page shows the section
 * with the collection's create affordance in its empty state ("Add child
 * page" — the create lands IN THE PAGES ZONE and focuses the new child by
 * opening it, the section's row-click behavior; the expanded section's
 * live re-query refreshes the list). Embedded feeds render the sections
 * read-only: no create affordance, and a childless feed entry hides the
 * section as before.
 *
 * Extracted from PageView.tsx.
 */

import { useCallback, useMemo, useState } from "react";

import { parseDateNodeId } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ReferenceEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { ReferenceSubtree } from "./ReferenceSubtree.js";
import { Section } from "../Section.js";
import { Tabs } from "./ui/index.js";
import { displayNameForSettings } from "../dateDisplay.js";
import { untitledLabelOf } from "../renderStateLabel.js";
import { useIgnoredUnlinkedRefs, writeIgnoredUnlinkedRef } from "../viewPrefs.js";
import { promoteMentionInAst } from "./unlinkedRefs.js";
import { FilterBlockBuilder } from "./FilterBlockBuilder.js";
import { Button } from "./ui/Button.js";
import { SearchField } from "./ui/SearchField.js";
import {
  EMPTY_FILTER_QUERY,
  filterQueryToGroup,
  isFilterInactive,
  type FilterQuery,
} from "./filterQuery.js";
import { NodeCollection, groupByContainingPage } from "../views/index.js";
import type { HostedViewsConfig, NodeCollectionItem } from "../views/index.js";
import { useSectionData, type SectionRowFilter } from "./useSectionData.js";
import "./SystemSections.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Cycle-protection depth cap for the recursive page tree. */
const PAGE_TREE_DEPTH_CAP = 64;

/** The bottom backlinks strip's tab values. */
const REF_TAB_BACKLINKS = "backlinks";
const REF_TAB_UNLINKED = "unlinked";

/** A main node plus its main CHILDREN (inline body blocks filtered out), recursive. */
function pageTreeOf(client: AnyClient, node: ClientNode, remaining = PAGE_TREE_DEPTH_CAP): NodeCollectionItem {
  return {
    node,
    children:
      remaining <= 0
        ? []
        : client
            .getChildren(node.id)
            .filter((child) => !child.isClass && child.presentAsMain)
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
 * Always rendered by its hosts — even empty: the hosted tab chrome stays
 * visible on an empty section, and `emptyText` (the section-empty line)
 * rides the selected tab's body.
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
  emptyText,
}: {
  entries: ReferenceEntry[];
  client: AnyClient;
  onOpenPage?: ((nodeId: string) => void) | undefined;
  unlinkedPageId?: string | undefined;
  hostedViews?: HostedViewsConfig | undefined;
  /** The section-empty line when there is nothing to list (rides the tab body for hosted collections). */
  emptyText?: string | undefined;
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
      {...(hostedViews !== undefined ? { hostedViews } : {})}
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
  // callback (and the hook's refreshKey below) on the joined value so its
  // identity stays stable between actual ignore-list changes; a churning
  // identity re-runs the effect every render and loops on the fresh-array
  // state installs (found by the test pass).
  const ignoredKey = ignored.join(" ");
  const loadUnlinkedRefs = useCallback(() => {
    const dismissed = new Set(ignoredKey === "" ? [] : ignoredKey.split(" "));
    return client
      .getUnlinkedReferences(pageId)
      .filter((entry) => !dismissed.has(entry.source.id));
  }, [client, pageId, ignoredKey]);
  const loadChildPages = useCallback(() => client.getChildPages(pageId), [client, pageId]);

  // The eager counts ride the tab labels (the backlink count is a
  // materialized read; the unlinked count its memoized count query — the
  // SystemSections precedent, so the labels know emptiness without running
  // the list queries). Date pages are the exception (owner 2026-10-09):
  // the whole deterministic day/month/year family hides the Unlinked
  // mentions tab — the literal date text those pages accumulate is noise,
  // never a discovery surface — so the count reads 0 there and the FTS
  // pass it pays is skipped entirely (the journal feed renders one
  // embedded day page per entry).
  const isDatePage = parseDateNodeId(pageId) !== null;
  const backlinkCount = client.getBacklinkCount(pageId);
  const unlinkedCount = isDatePage ? 0 : client.getUnlinkedReferenceCount(pageId);
  const childPageCount = client.getChildPageCount(pageId);

  // The bottom backlinks strip: hidden while the page has neither backlinks
  // nor unlinked mentions (owner 2026-10-08, the hide-when-empty ruling);
  // both tabs always show once it renders (owner 2026-10-06).
  // Each tab owns its useSectionData instance (the per-view rule — one
  // instance per view, never a shared cache with tab-switch invalidation);
  // the selected tab resolves on mount (the Tabs primitive swallows
  // re-clicks on the active tab, so the first load cannot ride onChange),
  // the other tab stays lazy until its first switch, rows cache across
  // switches (a switch is silent on the version), and a live notification
  // re-runs every LOADED tab's query (keepFresh — the pre-restructure contract: a
  // selected-again tab lands on fresh rows).
  const [refTab, setRefTab] = useState(REF_TAB_BACKLINKS);
  /**
   * The transient filter layer: one FilterQuery per tab (the per-view rule —
   * two useState instances, never one shared query; a tab switch keeps each
   * tab's own filter and never leaks it across). Component state, lost on
   * reload.
   */
  const [backlinkFilter, setBacklinkFilter] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  const [unlinkedFilter, setUnlinkedFilter] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  /**
   * The chrome's fold state — strip-level, NOT per tab: the unfolded search
   * field and the open builder survive a tab switch (owner 2026-10-09).
   */
  const [searchOpen, setSearchOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const backlinkRowFilter = useMemo<SectionRowFilter<ReferenceEntry> | undefined>(() => {
    if (isFilterInactive(backlinkFilter)) return undefined;
    const group = filterQueryToGroup(backlinkFilter);
    return group === null ? undefined : { group, nodeOf: (entry) => entry.source };
  }, [backlinkFilter]);
  const unlinkedRowFilter = useMemo<SectionRowFilter<ReferenceEntry> | undefined>(() => {
    if (isFilterInactive(unlinkedFilter)) return undefined;
    const group = filterQueryToGroup(unlinkedFilter);
    return group === null ? undefined : { group, nodeOf: (entry) => entry.source };
  }, [unlinkedFilter]);
  const backlinks = useSectionData<ReferenceEntry[]>({
    client,
    active: refTab === REF_TAB_BACKLINKS,
    keepFresh: true,
    read: loadLinkedRefs,
    filter: backlinkRowFilter,
  });
  const unlinked = useSectionData<ReferenceEntry[]>({
    client,
    active: refTab === REF_TAB_UNLINKED,
    keepFresh: true,
    // The device ignore list is not a client notification: key the refresh
    // gate on it so an Ignore drops the row without waiting for one.
    refreshKey: ignoredKey,
    read: loadUnlinkedRefs,
    filter: unlinkedRowFilter,
  });

  // The chrome binds to the ACTIVE tab's FilterQuery and result counts:
  // each tab still owns its query instance (the per-view rule — a switch
  // never leaks a filter across tabs), but the strip-level controls edit
  // whichever tab is active, so an open builder follows a tab switch.
  const activeFilter = refTab === REF_TAB_BACKLINKS ? backlinkFilter : unlinkedFilter;
  const setActiveFilter = refTab === REF_TAB_BACKLINKS ? setBacklinkFilter : setUnlinkedFilter;
  const activeRows = refTab === REF_TAB_BACKLINKS ? backlinks.rows : unlinked.rows;
  const activeMatchCount = activeRows === null ? null : activeRows.length;
  const activeTotalCount = refTab === REF_TAB_BACKLINKS ? backlinks.total : unlinked.total;
  const filterActive = !isFilterInactive(activeFilter);

  // The hide-when-empty rulings gate the backlinks strip; the Child pages
  // section renders on the MAIN surface even when childless (owner
  // 2026-10-09) — its header carries the create action, so the affordance
  // must be reachable exactly when there is nothing to list. Embedded
  // feeds keep the old ruling (read-only, childless hides). AFTER every
  // hook: the component flips between null and rendered as counts change,
  // so the hook order must stay unconditional.
  const showChildPages = !embedded || childPageCount > 0;
  if (!showChildPages && backlinkCount === 0 && unlinkedCount === 0) return null;

  return (
    <div className="nt-page-sections">
      {/* Child pages: always on the main surface (the header action creates
          a child page — the section-scoped create slot, owner 2026-10-09);
          embedded feeds stay hide-when-empty, read-only. */}
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
                    void client.createObject({ parentId: pageId, presentAsMain: true }),
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
              onNodeClick={(id) => onOpenPage?.(id)}
            />
          )}
        />
      )}
      {/* The backlinks strip — the page's references (Backlinks + Unlinked
          mentions) ride one tab bar in the old references-tab slot. It hides
          entirely while the page has neither (owner 2026-10-08, the
          hide-when-empty ruling that covers every system section); once it
          renders, both tabs always show (on date pages: only Backlinks —
          the Unlinked mentions tab never rides a date page) and the panel
          under a tab renders headerless (the tab is the header). The
          transient filter chrome rides the tab ROW, far right (owner
          2026-10-09): the magnifier folds/unfolds the quick search, the
          structured-filters toggle opens the builder below the row — both
          strip-level, binding to the active tab's query. An active filter
          emptying a tab keeps the chrome — the count gate reads the
          UNFILTERED rows. */}
      {(backlinkCount > 0 || unlinkedCount > 0) && (
      <div className="nt-backlinks">
        <Tabs className="nt-ref-tabs" value={refTab} onChange={setRefTab}>
          {/* The tab row: the tab bar left, the filter chrome far right. */}
          <div className="nt-ref-tabs-row">
            <Tabs.List>
              <Tabs.Tab value={REF_TAB_BACKLINKS}>
                Backlinks{backlinkCount > 0 ? ` ${backlinkCount}` : ""}
              </Tabs.Tab>
              {/* Date pages (the day/month/year family) carry no Unlinked
                  mentions tab — the literal-date matches are noise, and the
                  count is forced to 0 above, so the strip's gates read as if
                  the page had none. */}
              {!isDatePage && (
                <Tabs.Tab value={REF_TAB_UNLINKED}>
                  Unlinked mentions{unlinkedCount > 0 ? ` ${unlinkedCount}` : ""}
                </Tabs.Tab>
              )}
            </Tabs.List>
            <div className="nt-ref-chrome">
              {/* The quick search folds behind the icon-only magnifier:
                  unfolded it rides the row, capped so the tabs keep the
                  left side; folding away never drops the text (the toggle
                  stays highlighted while the active tab's text filter is
                  set). */}
              {searchOpen && (
                <SearchField
                  className="nt-ref-chrome__search"
                  aria-label="Filter by text"
                  placeholder="Filter…"
                  value={activeFilter.text ?? ""}
                  onChange={(event) => setActiveFilter({ ...activeFilter, text: event.target.value })}
                  onClear={() => setActiveFilter({ ...activeFilter, text: "" })}
                />
              )}
              {filterActive && activeMatchCount !== null && activeTotalCount !== null && (
                <span className="nt-filter-bar__count">
                  {activeMatchCount} of {activeTotalCount}
                </span>
              )}
              {filterActive && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  icon="mdi mdi-filter-remove-outline"
                  aria-label="Clear filter"
                  title="Clear filter"
                  onClick={() => {
                    setActiveFilter(EMPTY_FILTER_QUERY);
                    setBuilderOpen(false);
                  }}
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon="mdi mdi-magnify"
                aria-label="Search references"
                title="Filter by text"
                aria-expanded={searchOpen}
                active={searchOpen || (activeFilter.text?.trim() ?? "") !== ""}
                onClick={() => setSearchOpen((open) => !open)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon="mdi mdi-filter-variant"
                aria-label="Structured filters"
                title="More filters"
                aria-expanded={builderOpen}
                active={builderOpen || filterActive}
                onClick={() => setBuilderOpen((open) => !open)}
              />
            </div>
          </div>
          {/* The structured builder: an in-flow full-width region below the
              tab row (never an overlay), bound to the ACTIVE tab's draft
              group — left open across a tab switch, it edits the newly
              active tab's query. The region reuses the FilterBar's panel
              box (paired frame, the 2026-10-08 ruling). */}
          {builderOpen && (
            <div
              className="nt-filter-bar__panel"
              role="group"
              aria-label="Structured filters"
            >
              {activeMatchCount !== null && activeTotalCount !== null && (
                <p className="nt-filter-bar__result">
                  {activeMatchCount} of {activeTotalCount} rows match
                </p>
              )}
              <FilterBlockBuilder
                client={client}
                group={activeFilter.group}
                onChange={(group) => setActiveFilter({ ...activeFilter, group })}
              />
            </div>
          )}
          <Tabs.Panel value={REF_TAB_BACKLINKS}>
            {backlinks.rows === null ? null : (
              // Always rendered — the hosted tab bar (Default + "+" and the
              // custom views) stays visible on an empty section; the empty
              // line rides the selected tab's body.
              <ReferenceList
                entries={backlinks.rows}
                client={client}
                onOpenPage={onOpenPage}
                hostedViews={{ nodeId: pageId, sectionKey: "linked-references" }}
                emptyText="No backlinks."
              />
            )}
          </Tabs.Panel>
          {!isDatePage && (
            <Tabs.Panel value={REF_TAB_UNLINKED}>
              {unlinked.rows === null ? null : (
                <ReferenceList
                  entries={unlinked.rows}
                  client={client}
                  onOpenPage={onOpenPage}
                  unlinkedPageId={pageId}
                  hostedViews={{ nodeId: pageId, sectionKey: "unlinked-mentions" }}
                  emptyText="No unlinked mentions."
                />
              )}
            </Tabs.Panel>
          )}
        </Tabs>
      </div>
      )}
    </div>
  );
}
