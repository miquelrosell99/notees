/**
 * SystemSections — the card-bottom system sections: Linked references,
 * Child pages and Unlinked references, each in the shared NodeViewSection
 * starts expanded; the other two start collapsed. The lazy-loading contract
 * lives in Section (../Section.js): a collapsed section executes no query.
 *
 * Extracted from PageView.tsx.
 */

import { useCallback } from "react";

import { deriveDisplayName } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ReferenceEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { ReferenceSubtree } from "./ReferenceSubtree.js";
import { Section } from "../Section.js";
import "./SystemSections.css";

type AnyClient = WorkspaceClient | WorkerClient;

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
    const group = groups.get(entry.containingPageId);
    if (group !== undefined) group.items.push(entry);
    else groups.set(entry.containingPageId, { pageName: entry.containingPageName, items: [entry] });
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

  // Empty reference sections hide entirely (owner rule): linked refs read
  // the materialized backlink count, unlinked refs run its (memoized) count
  // query — the section header must know emptiness without an expand, and
  // windowed feeds (the journal) mount too few pages for that to matter.
  const backlinkCount = client.getBacklinkCount(pageId);
  const unlinkedCount = client.getUnlinkedReferenceCount(pageId);

  return (
    <div className="nt-page-sections">
      {backlinkCount > 0 && (
        <Section
          key={`linked-${pageId}`}
          client={client}
          title="Linked references"
          icon={<Icon path="mdi-link-variant" size={0.9} />}
          badge={backlinkCount}
          defaultCollapsed={false}
          load={loadLinkedRefs}
          emptyText="No linked references."
          renderResults={(entries) => <ReferenceList entries={entries} client={client} onOpenPage={onOpenPage} />}
        />
      )}
      <Section
        key={`child-${pageId}`}
        client={client}
        title="Child pages"
        icon={<Icon path="mdi-file-tree-outline" size={0.9} />}
        badge={client.getChildPageCount(pageId)}
        load={loadChildPages}
        emptyText="No child pages."
        renderResults={(pages) => (
          <ul className="nt-section-list">
            {pages.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  className="nt-section-item"
                  onClick={() => onOpenPage?.(child.id)}
                >
                  <RowIcon node={child} />
                  <span className="nt-section-row-name">{deriveDisplayName(child) || child.id}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      />
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
