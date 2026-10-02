/**
 * SystemSections — the card-bottom system sections: Linked references,
 * Child pages and Unlinked references, each in the shared NodeViewSection
 * starts expanded; the other two start collapsed. The lazy-loading contract
 * lives in Section (../Section.js): a collapsed section executes no query.
 *
 * Extracted from PageView.tsx.
 */

import { useCallback } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ReferenceEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { ReferenceSubtree } from "./ReferenceSubtree.js";
import { Section } from "../Section.js";
import { NodeCollection, groupByContainingPage } from "../views/index.js";
import type { NodeCollectionItem } from "../views/index.js";
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
 */
function ReferenceList({
  entries,
  client,
  onOpenPage,
}: {
  entries: ReferenceEntry[];
  client: AnyClient;
  onOpenPage?: ((nodeId: string) => void) | undefined;
}) {
  const items: NodeCollectionItem[] = entries.map((entry) => ({
    node: entry.source,
    meta: { containingPageId: entry.containingPageId },
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
        return (
          <>
            <Breadcrumbs
              client={client}
              nodeId={item.node.id}
              onOpenNode={onOpenPage}
              stopAfterId={containingPageId}
              excludeIds={containingPageId !== undefined ? [containingPageId] : undefined}
            />
            <ReferenceSubtree client={client} rootId={item.node.id} onOpenNode={onOpenPage} />
          </>
        );
      }}
    />
  );
}

export function SystemSections({
  client,
  pageId,
  onOpenPage,
}: {
  client: AnyClient;
  pageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const loadLinkedRefs = useCallback(() => client.getLinkedReferences(pageId), [client, pageId]);
  const loadUnlinkedRefs = useCallback(() => client.getUnlinkedReferences(pageId), [client, pageId]);
  const loadChildPages = useCallback(() => client.getChildPages(pageId), [client, pageId]);

  // Empty sections hide entirely (owner rule): linked refs read the
  // materialized backlink count, unlinked refs its (memoized) count query,
  // child pages the child count — the headers must know emptiness without
  // an expand, and windowed feeds (the journal) mount too few pages for
  // that to matter.
  const backlinkCount = client.getBacklinkCount(pageId);
  const unlinkedCount = client.getUnlinkedReferenceCount(pageId);
  const childPageCount = client.getChildPageCount(pageId);

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
      {backlinkCount > 0 && (
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
      )}
      {unlinkedCount > 0 && (
        <Section
          key={`unlinked-${pageId}`}
          client={client}
          title="Unlinked references"
          icon={<Icon path="mdi-link-off" size={0.9} />}
          load={loadUnlinkedRefs}
          emptyText="No unlinked references."
          renderResults={(entries) => <ReferenceList entries={entries} client={client} onOpenPage={onOpenPage} />}
        />
      )}
    </div>
  );
}
