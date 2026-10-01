/**
 * SystemSections — the card-bottom system sections: Linked references,
 * Child pages and Unlinked references, each in the shared NodeViewSection
 * starts expanded; the other two start collapsed. The lazy-loading contract
 * lives in Section (../Section.js): a collapsed section executes no query.
 *
 * Extracted from PageView.tsx.
 */

import { useCallback } from "react";

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, ReferenceEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings, displayNameFromClient } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { BlockRow } from "../BlockRow.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { ReferenceSubtree } from "./ReferenceSubtree.js";
import { Section } from "../Section.js";
import "./SystemSections.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Cycle-protection depth cap for the recursive page tree. */
const PAGE_TREE_DEPTH_CAP = 64;

/** A page node plus its child PAGES (blocks filtered out), recursive. */
function pageTreeOf(client: AnyClient, node: ClientNode, remaining = PAGE_TREE_DEPTH_CAP): BlockTreeNode {
  return {
    node,
    children:
      remaining <= 0
        ? []
        : client
            .getChildren(node.id)
            .filter((child) => child.nodeType === "page")
            .map((child) => pageTreeOf(client, child, remaining - 1)),
  };
}

/** Read-only blocks-list rows (no surrounding DndContext: non-draggable). */
function PageSubtreeList({ roots, client }: { roots: BlockTreeNode[]; client: AnyClient }) {
  return (
    <SortableContext items={roots.map((tree) => tree.node.id)} strategy={verticalListSortingStrategy}>
      <div className="nt-block-tree nt-block-tree--readonly">
        {roots.map((tree) => (
          <BlockRow
            key={tree.node.id}
            tree={tree}
            client={client}
            resolveName={(id) => displayNameFromClient(client, id)}
            readOnly
          />
        ))}
      </div>
    </SortableContext>
  );
}

/** A small page icon for a section row (the node's own icon when set). */
function RowIcon({ node }: { node: ClientNode }) {
  if (node.icon === null) return null;
  return <Icon path={node.icon} size={0.9} className="nt-section-row-icon" />;
}

/**
 * Logseq-style references: entries grouped under their containing page;
 * each row renders the referencing block's content (the block/editor view),
 * and clicking it opens the source — the block itself in focused view when
 * the edge is direct, otherwise the containing page.
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
  const groups = new Map<string, { pageName: string; items: ReferenceEntry[] }>();
  for (const entry of entries) {
    // containingPageName comes from the pure client (fixed slash format);
    // date pages reformat per the user's dateFormat at the display layer.
    const pageName = displayNameFromClient(client, entry.containingPageId) ?? entry.containingPageName;
    const group = groups.get(entry.containingPageId);
    if (group !== undefined) group.items.push(entry);
    else groups.set(entry.containingPageId, { pageName, items: [entry] });
  }
  return (
    <div className="nt-refgroups">
      {[...groups.entries()].map(([pageId, group]) => (
        <section key={pageId} className="nt-refgroup">
          <button
            type="button"
            className="nt-refgroup-page"
            onClick={() => onOpenPage?.(pageId)}
          >
            <Icon path="mdi-file-document-outline" size={0.9} className="nt-section-row-icon" />
            <span className="nt-refgroup-name">{group.pageName}</span>
            <span className="nt-refgroup-count">{group.items.length}</span>
          </button>
          <ul className="nt-refgroup-blocks">
            {group.items.map((entry) => (
              <li key={entry.source.id}>
                <Breadcrumbs
                  client={client}
                  nodeId={entry.source.id}
                  onOpenNode={onOpenPage}
                  stopAfterId={entry.containingPageId}
                  excludeIds={[entry.containingPageId]}
                />
                <ReferenceSubtree client={client} rootId={entry.source.id} onOpenNode={onOpenPage} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
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
            // The blocks list in read-only mode, filtered to pages, recursing
            // through the child-page tree (v1's readonly blocks-list prop).
            <PageSubtreeList
              roots={pages.map((child) => pageTreeOf(client, child))}
              client={client}
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
