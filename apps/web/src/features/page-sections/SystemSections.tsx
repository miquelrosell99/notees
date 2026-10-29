/**
 * SystemSections — the page's reference family as THREE SELF-GATING
 * sections (the `SystemSections` group component died by
 * subtraction — 2026-10-20 retired its wrapper chrome and its all-empty
 * gate; this slice retires the component itself). Each section renders ONLY
 * while its OWN eager count reads > 0 (the hide-when-empty ruling,-12 — the gate lives IN the section now, the ExtendedBySection
 * pattern: an eager count read, `null` when 0, then the lazy section
 * component) and each mounts through the variant's `systemSections`
 * descriptor list (pageVariant.ts) — placement is data, there is no group
 * mount. Below the page's own content, in order: Child pages (expanded, the
 * create affordance), then the page's references as TWO normal
 * NodeCollection sections (the tab strip's retirement):
 * Backlinks and Unlinked mentions each ride the shared collapsible-section
 * chrome — the NodeViewSection header IS the section header, the tab row is
 * gone — with the hosted view chrome, the transient
 * NodeCollectionToolbar, and the lazy useSectionData contract every other section has.
 * One count semantics everywhere (displayed nodes), named exactly once
 *: the hosted
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
 * rides the shared NodeCollectionToolbar (./NodeCollectionToolbar.js — the same
 * chrome the classed-nodes section renders), since in the
 * hosted tab bar's FAR RIGHT as the collection's `tabBarTrailing` (the
 * collapsible quick search + the structured-filters toggle — one row with
 * the tabs): one FilterQuery per section (the per-view rule, component
 * state — nothing persisted), applied post-resolution/pre-windowing; an
 * active filter reads "0 of N" in the bar and never hides the section.
 *
 * The Child pages section renders only while the page has main children
 * (the "always renders on the main surface" exception
 * retired; the create gesture lives in the "…" menu and the New button).
 * When it renders, the header carries the create affordance ("Add child
 * page" — the create lands IN THE PAGES ZONE and focuses the new child by
 * opening it, the section's row-click behavior; the expanded section's
 * live re-query refreshes the list, so the new row appears at once).
 * The tree opens on the Name A–Z sort, every sibling
 * level — the drag/position order stays one sort-button switch away.
 * Embedded feeds render the sections read-only: no create affordance, and
 * a childless feed entry hides the section as before.
 *
 * Extracted from PageView.tsx; the group component subtracted 2026-10-21.
 */

import { useCallback, useState, type ReactNode } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ReferenceEntry, WorkspaceClient } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { titleOfNode } from "../../ui/dateDisplay.js";
import { parentlessBlockResolverOf } from "../../ui/renderStateLabel.js";
import { useIgnoredUnlinkedRefs, writeIgnoredUnlinkedRef } from "../../ui/viewPrefs.js";
import { promoteMentionInAst } from "../collection/unlinkedRefs.js";
import { CollectionSection } from "../collection/CollectionSection.js";
import {
  EMPTY_FILTER_QUERY,
  draftOrFactoryAst,
  quickTextOf,
  type FilterQuery,
} from "../collection/filterQuery.js";
import { groupByContainingPage } from "../collection/index.js";
import type { HostedViewsConfig } from "../collection/index.js";
import { SECTION_DEFAULT_TAB } from "../collection/NodeCollectionTabs.js";
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


/** Crumb-safe row label for the action aria labels. */
function displayNameOf(
  node: ClientNode,
  isParentlessBlockClass?: (classId: string) => boolean,
): string {
  return titleOfNode(node, { empty: "untitled", isParentlessBlockClass });
}

/**
 * ReferenceSection — ONE of the page's reference sections (Backlinks /
 * Unlinked mentions) composing through the CollectionSection skin: the
 * chrome, the lazy contract, the transient filter layer, and the hosted
 * tabs all ride the skin; this component keeps only what a reference
 * section OWNS — the entry→item mapping (the per-row scope-classed re-read:
 * a source edited without touching this page leaves its pooled snapshot
 * stale, so each item re-reads its source through the scope-classed getNode,
 * which the source's own edit invalidates), the containing-page grouping,
 * the live sort default (ranked quick text leads until the user picks a
 * sort), the lifted hosted-tab state ("Save as tab" persists the draft as a
 * section view and must SELECT the new tab — controlled hostedViews, which
 * also auto-wires the skin's toolbar Save-as-tab), and the Promote/Ignore
 * row-action pair (the unlinked section only — `unlinkedPageId` enables it:
 * Promote converts the literal match into a mention; Ignore dismisses the
 * source for this page, device-locally).
 *
 * The rows answer content edits like the tasks hub (`readOnly={false}`, NOT
 * `editable` — no drag order, so the read-time sort button stays). The
 * section opens on the Dates-first sort: date-page groups newest → oldest,
 * then the other pages A–Z. Always rendered by its hosts — even empty: the
 * hosted view chrome stays visible on an empty section, and `emptyText`
 * (the section-empty line) rides the collection's empty state. The block
 * backlink card mounts BacklinksSection (this file) in a card — the whole
 * section chrome, `hideHeader` — the gutter toggle owns the surface there.
 * `refreshKey` carries the device-only values the read closes over (the
 * unlinked ignore list — not a client notification).
 */
function ReferenceSection({
  client,
  pageId,
  title,
  icon,
  load,
  refreshKey,
  unlinkedPageId,
  hideHeader = false,
  sectionKey,
  emptyText,
  defaultExpanded = false,
  onOpenPage,
}: {
  client: AnyClient;
  pageId: string;
  title: string;
  icon: ReactNode;
  /** The references read (the cheap linked pass / the expensive FTS pass). */
  load: () => ReferenceEntry[];
  /** Values the read closes over that change without a client notification. */
  refreshKey?: string | undefined;
  /** Enables the Promote/Ignore row actions (the unlinked section only). */
  unlinkedPageId?: string | undefined;
  /**
   * Hide the section header ENTIRELY (the block backlink card: the gutter
   * toggle owns the surface, the hosted tab names the section).
   */
  hideHeader?: boolean | undefined;
  /** The hosted custom views' section key (per-section saved views). */
  sectionKey: HostedViewsConfig["sectionKey"];
  emptyText: string;
  /** Backlinks starts expanded (the cheap incoming-direction read); Unlinked mentions stays collapsed. */
  defaultExpanded?: boolean;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  /**
   * The host's own FilterQuery COPY: the skin owns the transient state and
   * reports it here — the host derives the live sort default and the new
   * tab's starter AST (`createAst`) from the copy.
   */
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  /**
   * The hosted tab state, lifted: "Save as tab"
   * persists the draft as a section view and must SELECT the new tab — the
   * tab state lives here, handed to the collection as a controlled
   * hostedViews (which also auto-wires the skin's toolbar Save-as-tab).
   */
  const [tab, setTab] = useState<string>(SECTION_DEFAULT_TAB);
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
  return (
    <CollectionSection
      client={client}
      title={title}
      icon={icon}
      className="nt-section"
      hideHeader={hideHeader}
      defaultCollapsed={!defaultExpanded}
      filterable
      emptyText={emptyText}
      viewMode="outline"
      read={() =>
        load().map((entry) => ({
          // The reference reads are scope-classed (op-lag slice 3): a source
          // edited without touching this page leaves its pooled snapshot stale —
          // each item re-reads its source through the scope-classed getNode,
          // which the source's own edit invalidates.
          node: client.getNode(entry.source.id) ?? entry.source,
          meta: { containingPageId: entry.containingPageId, verb: entry.verb },
        }))
      }
      {...(refreshKey !== undefined ? { refreshKey } : {})}
      onFilterChange={setFilterQuery}
      groupBy={(items) => {
        const { standalone, groups } = groupByContainingPage(client, items, onOpenPage);
        return { groups, ungroupedItems: standalone };
      }}
      collection={{
        /**
         * Editable rows (reference rows answer content edits; an edit that
         * removes the mention honestly moves the row to the other section or
         * out of it). `readOnly={false}` rather than `editable`: this is NOT
         * a drag-ordered editing surface, so the read-time sort button must
         * stay (an `editable` surface hides it — there the sort would fight
         * the drag order).
         */
        readOnly: false,
        defaultSortMode: quickTextOf(filterQuery) === "" ? "dates-first" : "position",
        onNodeClick: (id) => onOpenPage?.(id),
        hostedViews: {
          nodeId: pageId,
          sectionKey,
          createAst: () => draftOrFactoryAst(filterQuery),
          selected: tab,
          onSelectTab: setTab,
          defaultViewLabel: title,
        },
        trailingAction: (item) => {
          if (unlinkedPageId === undefined) return null;
          // What a row still owns rides the shared trailing-action seam: the
          // Promote/Ignore pair (the row end is identity chrome, the property
          // context lives in the row's own Properties table).
          return (
            <span className="nt-ref-actions">
              <button
                type="button"
                className="nt-ref-action"
                aria-label={`Promote ${displayNameOf(item.node, parentlessBlockResolverOf(client))} to a link`}
                title="Promote to link"
                onClick={() => promote(item.node)}
              >
                <Icon path="mdi-link-plus" size={0.8} />
              </button>
              <button
                type="button"
                className="nt-ref-action"
                aria-label={`Ignore ${displayNameOf(item.node, parentlessBlockResolverOf(client))}`}
                title="Ignore (this device)"
                onClick={() => writeIgnoredUnlinkedRef(unlinkedPageId, item.node.id, true)}
              >
                <Icon path="mdi-eye-off-outline" size={0.8} />
              </button>
            </span>
          );
        },
      }}
    />
  );
}


/**
 * ChildPagesSection — the page's main children as the read-only tree, ONE
 * self-gating section: the eager count reads first, the
 * skin's hide-when-empty gate renders null while it reads 0, else the lazy
 * read mounts — the ExtendedBySection pattern. The header carries the
 * create affordance ("Add child page" — the create lands IN THE PAGES ZONE,
 * embedded feeds render read-only with no action). The tree opens on the
 * Name A–Z sort. Composes through the CollectionSection skin.
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
  /** The peek-card surface: start collapsed regardless of the surface default. */
  sectionsStartCollapsed = false,
}: {
  client: AnyClient;
  pageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  embedded?: boolean | undefined;
  sectionsStartCollapsed?: boolean | undefined;
}) {
  const childPageCount = client.getChildPageCount(pageId);
  return (
    <CollectionSection
      client={client}
      title="Child pages"
      icon={<Icon path="mdi-file-tree-outline" size={0.9} />}
      count={childPageCount}
      hideWhenEmpty
      defaultCollapsed={sectionsStartCollapsed}
      className="nt-section"
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
      emptyText="No child pages."
      viewMode="outline"
      read={() => client.getChildPages(pageId).map((child) => pageTreeOf(client, child))}
      collection={{
        tree: true,
        readOnly: true,
        hideBacklinkCount: true,
        showBreadcrumbs: false,
        collapse: true,
        defaultSortMode: "alphabetical",
        onNodeClick: (id) => onOpenPage?.(id),
      }}
    />
  );
}

/**
 * BacklinksSection — the incoming direction, expanded by default (its read
 * is cheap; the old tab strip's selected tab resolved on mount). Self-gates
 * on the eager materialized count (null while 0 — the hide-when-empty
 * ruling covers every reference section); the count itself no longer
 * displays anywhere — the active tab's badge
 * names the displayed rows. The block backlink card mounts it with
 * `hideHeader` — the gutter toggle owns show/hide there.
 */
export function BacklinksSection({
  client,
  pageId,
  onOpenPage,
  hideHeader = false,
  /** The peek-card surface: start collapsed (the card is a glance). */
  sectionsStartCollapsed = false,
}: {
  client: AnyClient;
  pageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Hide the header's collapse toggle (the block backlink card's gutter toggle owns show/hide there). */
  hideHeader?: boolean | undefined;
  sectionsStartCollapsed?: boolean | undefined;
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
      {...(hideHeader ? { hideHeader: true } : {})}
      sectionKey="linked-references"
      emptyText="No backlinks."
      defaultExpanded={!sectionsStartCollapsed}
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
 *: the date variants' systemSections omit this spec, so
 * neither the section nor its FTS count mounts there — the old runtime
 * count-forced-to-0 gate retired with the group.
 */
export function UnlinkedMentionsSection({
  client,
  pageId,
  onOpenPage,
  /** The peek-card surface: already collapsed by default — accepted for
   *  the descriptor's uniform contract. */
  sectionsStartCollapsed: _sectionsStartCollapsed = false,
}: {
  client: AnyClient;
  pageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  sectionsStartCollapsed?: boolean | undefined;
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
