/**
 * SystemSections — the card-bottom system sections. Below the page's own
 * content: the Child pages section (expanded) and the workspace Activity
 * feed (§34.19 :1167, mounted last; off for embedded renders via
 * `withActivity`) stay stacked sections as before; only the REFERENCES
 * rework rides the tab strip (owner 2026-10-06, the Capacities-style
 * layout): ONE tab bar in the old references-tab slot — Backlinks and
 * Unlinked mentions (renamed from "unlinked references") — always showing
 * both tabs even when empty. The tab label carries the eager count; a tab's
 * list query runs lazily on its first activation (the SCHEMA.md lazy
 * contract), the results cache across tab switches, and a live notification
 * re-runs the loaded tabs' queries. The tabbed panels render headerless —
 * the tab IS the section header (no duplicated tabs-plus-section-headers
 * chrome).
 *
 * Unlinked mentions carry the v1 action pair (§34.27 L4, §34.19 :1137):
 * Promote rewrites the source block's literal name match into a mention
 * (./unlinkedRefs.ts — after the write the source moves to Backlinks, the
 * honest place for it); Ignore dismisses the source device-locally, per
 * page — device state, never an op (./viewPrefs.js).
 *
 * Extracted from PageView.tsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { NodeCollection, groupByContainingPage } from "../views/index.js";
import type { NodeCollectionItem } from "../views/index.js";
import { ActivityLogSection } from "./ActivityLogSection.js";
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
}: {
  entries: ReferenceEntry[];
  client: AnyClient;
  onOpenPage?: ((nodeId: string) => void) | undefined;
  unlinkedPageId?: string | undefined;
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
   * §34.69 bound-verb backlinks: a linked-reference edge whose verb is a
   * bound propertySchemaId renders the schema's NAME (never the raw id) —
   * the surfaces the backlink arrived through ("supports", "cites"). Free
   * verbs never produce targeted edges (typed-link marks are targetless per
   * the M2-deferred resolution ruling), so the badge only ever names a
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
   * The workspace activity feed (§34.19 :1167). Off for embedded renders —
   * a journal feed mounts many PageViews and the feed's created-query gate
   * would run once per mounted page per notification.
   */
  withActivity = true,
}: {
  client: AnyClient;
  pageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  withActivity?: boolean | undefined;
}) {
  const loadLinkedRefs = useCallback(() => client.getLinkedReferences(pageId), [client, pageId]);
  const ignored = useIgnoredUnlinkedRefs(pageId);
  // The ignore-list hook hands back a FRESH array every render — key the
  // callback on the joined value so its identity (and the refresh effect's
  // deps below) stays stable between actual ignore-list changes; a churning
  // identity re-runs that effect every render and loops on the fresh-array
  // state installs (found by the §34.116 test pass).
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
  // the list queries).
  const backlinkCount = client.getBacklinkCount(pageId);
  const unlinkedCount = client.getUnlinkedReferenceCount(pageId);
  const childPageCount = client.getChildPageCount(pageId);

  // The bottom backlinks strip: both tabs always visible (owner 2026-10-06),
  // a tab's list query runs on its FIRST activation only (lazy per the
  // SCHEMA.md contract), the rows cache across tab switches, and a live
  // notification re-runs the loaded tabs' queries (the Section contract).
  const [refTab, setRefTab] = useState(REF_TAB_BACKLINKS);
  const [backlinkRows, setBacklinkRows] = useState<ReferenceEntry[] | null>(null);
  const [unlinkedRows, setUnlinkedRows] = useState<ReferenceEntry[] | null>(null);
  const [backlinksVersion, setBacklinksVersion] = useState(0);
  useEffect(() => client.subscribe(() => setBacklinksVersion((v) => v + 1)), [client]);
  useEffect(() => {
    if (backlinkRows !== null) {
      try {
        setBacklinkRows(loadLinkedRefs());
      } catch {
        // Closed client / failed query: keep the previous rows.
      }
    }
    if (unlinkedRows !== null) {
      try {
        setUnlinkedRows(loadUnlinkedRefs());
      } catch {
        // Closed client / failed query: keep the previous rows.
      }
    }
    // Re-run the loaded tabs' queries per notification (the Section
    // contract); the lazy tabs stay silent until their first activation.
  }, [client, backlinksVersion, loadLinkedRefs, loadUnlinkedRefs]);
  const activateRefTab = (tab: string) => {
    setRefTab(tab);
    try {
      if (tab === REF_TAB_BACKLINKS && backlinkRows === null) {
        setBacklinkRows(loadLinkedRefs());
      }
      if (tab === REF_TAB_UNLINKED && unlinkedRows === null) {
        setUnlinkedRows(loadUnlinkedRefs());
      }
    } catch {
      // Failed first load: the panel renders its empty state honestly.
    }
  };
  /**
   * The initially-selected tab is active from the first render, and the Tabs
   * primitive swallows re-clicks on the active tab — so onChange can never
   * fire for it and its first load must run here (without this the default
   * tab's panel stayed blank until the user switched away and back). The
   * other tab stays lazy until a real switch.
   */
  const initialTabLoaded = useRef(false);
  useEffect(() => {
    if (initialTabLoaded.current) return;
    initialTabLoaded.current = true;
    try {
      if (refTab === REF_TAB_BACKLINKS) setBacklinkRows(loadLinkedRefs());
      else setUnlinkedRows(loadUnlinkedRefs());
    } catch {
      // Failed first load: the panel renders its empty state honestly.
    }
  }, [refTab, loadLinkedRefs, loadUnlinkedRefs]);

  return (
    <div className="nt-page-sections">
      {childPageCount > 0 && (
        <Section
          key={`child-${pageId}`}
          client={client}
          title="Child pages"
          icon={<Icon path="mdi-file-tree-outline" size={0.9} />}
          badge={childPageCount}
          defaultCollapsed={false}
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
          mentions) ride one tab bar in the old references-tab slot. Both
          tabs always show; the panel under a tab renders headerless (the
          tab is the header). The other system sections are untouched. */}
      <div className="nt-backlinks">
        <Tabs className="nt-ref-tabs" value={refTab} onChange={activateRefTab}>
          <Tabs.List>
            <Tabs.Tab value={REF_TAB_BACKLINKS}>
              Backlinks{backlinkCount > 0 ? ` ${backlinkCount}` : ""}
            </Tabs.Tab>
            <Tabs.Tab value={REF_TAB_UNLINKED}>
              Unlinked mentions{unlinkedCount > 0 ? ` ${unlinkedCount}` : ""}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value={REF_TAB_BACKLINKS}>
            {backlinkRows === null ? null : backlinkRows.length === 0 ? (
              <div className="nt-section-empty">No backlinks.</div>
            ) : (
              <ReferenceList entries={backlinkRows} client={client} onOpenPage={onOpenPage} />
            )}
          </Tabs.Panel>
          <Tabs.Panel value={REF_TAB_UNLINKED}>
            {unlinkedRows === null ? null : unlinkedRows.length === 0 ? (
              <div className="nt-section-empty">No unlinked mentions.</div>
            ) : (
              <ReferenceList
                entries={unlinkedRows}
                client={client}
                onOpenPage={onOpenPage}
                unlinkedPageId={pageId}
              />
            )}
          </Tabs.Panel>
        </Tabs>
      </div>
      {withActivity && <ActivityLogSection client={client} onOpenPage={onOpenPage} />}
    </div>
  );
}
