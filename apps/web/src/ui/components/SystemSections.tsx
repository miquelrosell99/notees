/**
 * SystemSections — the card-bottom system sections. Below the page's own
 * content: the Child pages section (expanded) stays stacked as before; only
 * the REFERENCES rework rides the tab strip (owner 2026-10-06, the
 * Capacities-style layout): ONE tab bar in the old references-tab slot —
 * Backlinks and Unlinked mentions (renamed from "unlinked references") —
 * always showing both tabs even when empty. The tab label carries the eager
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
 * The transient filter layer (owner 2026-10-07): both tabs are filterable —
 * a FilterBar rides each panel's body top (the tab IS the header; the bar
 * cannot nest in it), each tab owning its FilterSpec instance (component
 * state — a switch never leaks a filter across tabs, nothing persisted).
 * The spec filters the tab's resolved rows post-resolution/pre-windowing;
 * the eager counts on the tab labels stay UNFILTERED — an active filter
 * reads "0 of N" in the bar and never empties the tab away.
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
import { FilterBar } from "./FilterBar.js";
import { EMPTY_FILTER_SPEC, isFilterEmpty, type FilterSpec } from "./filterSpec.js";
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
 * Exported for the block-level backlink gutter (SCHEMA.md:117 — the expanded
 * linked-references section beneath a block row reuses this rendering).
 */
export function ReferenceList({
  entries,
  client,
  onOpenPage,
  unlinkedPageId,
  hostedViews,
}: {
  entries: ReferenceEntry[];
  client: AnyClient;
  onOpenPage?: ((nodeId: string) => void) | undefined;
  unlinkedPageId?: string | undefined;
  hostedViews?: HostedViewsConfig | undefined;
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
   * Embedded surfaces (journal feeds) render the sections read-only: the
   * Child pages create affordance stays a main-surface privilege, same as
   * the body's ghost row.
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
  /**
   * The Child pages create affordance — the collection contract's flag +
   * callback + context: the context is the main surface (embedded feeds
   * never create) WITH a navigation target (the create focuses the new
   * child by opening it, the section's row-click behavior). The create
   * lands IN THE PAGES ZONE (presentAsMain); the section's live re-query
   * (an expanded section re-runs on the write notification) refreshes the
   * list.
   */
  const addChildPage =
    !embedded && onOpenPage !== undefined
      ? () => {
          void client
            .createObject({ parentId: pageId, presentAsMain: true })
            .then((childId) => onOpenPage(childId));
        }
      : undefined;

  // The eager counts ride the tab labels (the backlink count is a
  // materialized read; the unlinked count its memoized count query — the
  // SystemSections precedent, so the labels know emptiness without running
  // the list queries).
  const backlinkCount = client.getBacklinkCount(pageId);
  const unlinkedCount = client.getUnlinkedReferenceCount(pageId);
  const childPageCount = client.getChildPageCount(pageId);

  // The bottom backlinks strip: both tabs always visible (owner 2026-10-06).
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
   * The transient filter layer: one FilterSpec per tab (the per-view rule —
   * two useState instances, never one shared spec; a tab switch keeps each
   * tab's own filter and never leaks it across). Component state, lost on
   * reload.
   */
  const [backlinkFilter, setBacklinkFilter] = useState<FilterSpec>(EMPTY_FILTER_SPEC);
  const [unlinkedFilter, setUnlinkedFilter] = useState<FilterSpec>(EMPTY_FILTER_SPEC);
  const backlinkRowFilter = useMemo<SectionRowFilter<ReferenceEntry> | undefined>(() => {
    if (isFilterEmpty(backlinkFilter)) return undefined;
    return { spec: backlinkFilter, nodeOf: (entry) => entry.source };
  }, [backlinkFilter]);
  const unlinkedRowFilter = useMemo<SectionRowFilter<ReferenceEntry> | undefined>(() => {
    if (isFilterEmpty(unlinkedFilter)) return undefined;
    return { spec: unlinkedFilter, nodeOf: (entry) => entry.source };
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

  return (
    <div className="nt-page-sections">
      {/* The Child pages section: hidden only when the surface cannot create
          (embedded feeds, no navigation target) AND the page has none — an
          empty main-surface page renders the section with the collection's
          create affordance in its empty state. */}
      {(childPageCount > 0 || addChildPage !== undefined) && (
        <Section
          key={`child-${pageId}`}
          client={client}
          title="Child pages"
          icon={<Icon path="mdi-file-tree-outline" size={0.9} />}
          badge={childPageCount > 0 ? childPageCount : undefined}
          defaultCollapsed={false}
          load={loadChildPages}
          emptyText="No child pages."
          renderWhenEmpty={addChildPage !== undefined}
          renderResults={(pages) => (
            // The reusable outline view over the read-only child-page tree
            // (rows open the page via the row click, per the outline view's
            // read-only tree path). Empty on the main surface: the kit
            // EmptyState carries the "Add child page" create affordance.
            <NodeCollection
              viewMode="outline"
              client={client}
              items={pages.map((child) => pageTreeOf(client, child))}
              tree
              readOnly
              onNodeClick={(id) => onOpenPage?.(id)}
              {...(addChildPage !== undefined
                ? {
                    emptyTitle: "No child pages.",
                    emptyHint: "Pages created here live under this page.",
                    showAddButton: true,
                    onAdd: addChildPage,
                    addLabel: "Add child page",
                  }
                : {})}
            />
          )}
        />
      )}
      {/* The backlinks strip — the page's references (Backlinks + Unlinked
          mentions) ride one tab bar in the old references-tab slot. Both
          tabs always show; the panel under a tab renders headerless (the
          tab is the header). The other system sections are untouched. */}
      <div className="nt-backlinks">
        <Tabs className="nt-ref-tabs" value={refTab} onChange={setRefTab}>
          <Tabs.List>
            <Tabs.Tab value={REF_TAB_BACKLINKS}>
              Backlinks{backlinkCount > 0 ? ` ${backlinkCount}` : ""}
            </Tabs.Tab>
            <Tabs.Tab value={REF_TAB_UNLINKED}>
              Unlinked mentions{unlinkedCount > 0 ? ` ${unlinkedCount}` : ""}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value={REF_TAB_BACKLINKS}>
            <FilterBar
              client={client}
              value={backlinkFilter}
              onChange={setBacklinkFilter}
              matchCount={backlinks.rows === null ? null : backlinks.rows.length}
              totalCount={backlinks.total}
            />
            {backlinks.rows === null ? null : backlinks.rows.length === 0 ? (
              <div className="nt-section-empty">No backlinks.</div>
            ) : (
              <ReferenceList
                entries={backlinks.rows}
                client={client}
                onOpenPage={onOpenPage}
                hostedViews={{ nodeId: pageId, sectionKey: "linked-references" }}
              />
            )}
          </Tabs.Panel>
          <Tabs.Panel value={REF_TAB_UNLINKED}>
            <FilterBar
              client={client}
              value={unlinkedFilter}
              onChange={setUnlinkedFilter}
              matchCount={unlinked.rows === null ? null : unlinked.rows.length}
              totalCount={unlinked.total}
            />
            {unlinked.rows === null ? null : unlinked.rows.length === 0 ? (
              <div className="nt-section-empty">No unlinked mentions.</div>
            ) : (
              <ReferenceList
                entries={unlinked.rows}
                client={client}
                onOpenPage={onOpenPage}
                unlinkedPageId={pageId}
                hostedViews={{ nodeId: pageId, sectionKey: "unlinked-mentions" }}
              />
            )}
          </Tabs.Panel>
        </Tabs>
      </div>
    </div>
  );
}
