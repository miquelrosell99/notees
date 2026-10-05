/**
 * SystemSections — the card-bottom system sections. Below the page's own
 * content: the Child pages section (expanded) and the workspace Activity
 * feed (§34.19 :1167, mounted last; off for embedded renders via
 * `withActivity`) stay stacked as today, while the three reference sections
 * live behind one tab strip (#5): Linked references, References (the
 * outgoing mirror — document-chrome pages this node points at, via the
 * source-side roll-up in @notees/store), and Unlinked references (the only
 * tab carrying the promote/ignore action pair). Each tab mounts its lazy
 * Section inside a Tabs.Panel, which renders only while the tab is active —
 * a collapsed section still executes no query, and an inactive tab's query
 * never runs at all. Empty tabs hide entirely (owner rule): the strip
 * appears only when at least one tab has rows, and an active tab that
 * emptied falls back to the first non-empty one.
 *
 * The lazy-loading contract lives in Section (../Section.js): a collapsed
 * section executes no query.
 *
 * Unlinked references carry the v1 action pair (§34.27 L4, §34.19 :1137):
 * Promote rewrites the source block's literal name match into a mention
 * (./unlinkedRefs.ts — after the write the source moves to Linked, the
 * honest place for it); Ignore dismisses the source device-locally, per
 * page — device state, never an op (./viewPrefs.js).
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
import { NodeCollection, groupByContainingPage } from "../views/index.js";
import type { NodeCollectionItem } from "../views/index.js";
import { ActivityLogSection } from "./ActivityLogSection.js";
import "./SystemSections.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Cycle-protection depth cap for the recursive page tree. */
const PAGE_TREE_DEPTH_CAP = 64;

/** The references tab strip's tab values (#5). */
const REF_TAB_LINKED = "linked";
const REF_TAB_REFERENCES = "references";
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
  const loadReferences = useCallback(() => client.getReferences(pageId), [client, pageId]);
  const ignored = useIgnoredUnlinkedRefs(pageId);
  const loadUnlinkedRefs = useCallback(() => {
    const dismissed = new Set(ignored);
    return client
      .getUnlinkedReferences(pageId)
      .filter((entry) => !dismissed.has(entry.source.id));
  }, [client, pageId, ignored]);
  const loadChildPages = useCallback(() => client.getChildPages(pageId), [client, pageId]);

  // Empty sections hide entirely (owner rule): linked refs read the
  // materialized backlink count, unlinked refs its (memoized) count query,
  // child pages the child count — the headers must know emptiness without
  // an expand, and windowed feeds (the journal) mount too few pages for
  // that to matter. The References tab reads the same roll-up its list
  // renders (getReferenceCount), so its badge and rows cannot diverge.
  const backlinkCount = client.getBacklinkCount(pageId);
  const unlinkedCount = client.getUnlinkedReferenceCount(pageId);
  const childPageCount = client.getChildPageCount(pageId);
  const referenceCount = client.getReferenceCount(pageId);

  // The three reference sections share one tab strip. Tabs.Panel renders
  // only while active, so an inactive tab's Section never mounts — the
  // Section lazy contract (collapsed ⇒ no query) holds per active tab.
  // Empty tabs hide (owner rule): the strip appears only when at least one
  // tab has rows; an active tab that emptied (e.g. the last unlinked ref
  // promoted) falls back to the first non-empty tab.
  const [refTab, setRefTab] = useState(REF_TAB_LINKED);
  const refTabs = [
    backlinkCount > 0 ? { value: REF_TAB_LINKED, label: "Linked references" } : null,
    referenceCount > 0 ? { value: REF_TAB_REFERENCES, label: "References" } : null,
    unlinkedCount > 0 ? { value: REF_TAB_UNLINKED, label: "Unlinked references" } : null,
  ].filter((tab): tab is { value: string; label: string } => tab !== null);
  const activeRefTab = refTabs.some((tab) => tab.value === refTab)
    ? refTab
    : (refTabs[0]?.value ?? REF_TAB_LINKED);

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
      {refTabs.length > 0 && (
        <Tabs className="nt-ref-tabs" value={activeRefTab} onChange={setRefTab}>
          <Tabs.List>
            {refTabs.map((tab) => (
              <Tabs.Tab key={tab.value} value={tab.value}>
                {tab.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <Tabs.Panel value={REF_TAB_LINKED}>
            <Section
              key={`linked-${pageId}`}
              client={client}
              title="Linked references"
              icon={<Icon path="mdi-link-variant" size={0.9} />}
              badge={backlinkCount}
              defaultCollapsed
              load={loadLinkedRefs}
              emptyText="No linked references."
              renderResults={(entries) => <ReferenceList entries={entries} client={client} onOpenPage={onOpenPage} />}
            />
          </Tabs.Panel>
          <Tabs.Panel value={REF_TAB_REFERENCES}>
            <Section
              key={`references-${pageId}`}
              client={client}
              title="References"
              icon={<Icon path="mdi-file-document-outline" size={0.9} />}
              badge={referenceCount}
              defaultCollapsed
              load={loadReferences}
              emptyText="No references."
              renderResults={(targets) => (
                // The outgoing mirror of linked references: the referenced
                // pages themselves (the tab is about targets, so the rows
                // are the simple read-only outline — no source breadcrumbs).
                <NodeCollection
                  viewMode="outline"
                  client={client}
                  items={targets.map((target) => ({ node: target }))}
                  readOnly
                  onNodeClick={(id) => onOpenPage?.(id)}
                />
              )}
            />
          </Tabs.Panel>
          <Tabs.Panel value={REF_TAB_UNLINKED}>
            <Section
              key={`unlinked-${pageId}`}
              client={client}
              title="Unlinked references"
              icon={<Icon path="mdi-link-off" size={0.9} />}
              load={loadUnlinkedRefs}
              emptyText="No unlinked references."
              renderResults={(entries) => (
                <ReferenceList
                  entries={entries}
                  client={client}
                  onOpenPage={onOpenPage}
                  unlinkedPageId={pageId}
                />
              )}
            />
          </Tabs.Panel>
        </Tabs>
      )}
      {withActivity && <ActivityLogSection client={client} onOpenPage={onOpenPage} />}
    </div>
  );
}
