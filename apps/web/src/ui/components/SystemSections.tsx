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
import { Section } from "../Section.js";
import "./SystemSections.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** A small page icon for a section row (the node's own icon when set). */
function RowIcon({ node }: { node: ClientNode }) {
  if (node.icon === null) return null;
  return <Icon path={node.icon} size={0.9} className="nt-section-row-icon" />;
}

/** One references row: containing-page crumb, source excerpt, containment context. */
function ReferenceList({
  entries,
  onOpenPage,
}: {
  entries: ReferenceEntry[];
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  return (
    <ul className="nt-section-list">
      {entries.map((entry) => (
        <li key={entry.source.id}>
          <button
            type="button"
            className="nt-section-item"
            onClick={() => onOpenPage?.(entry.containingPageId)}
          >
            <RowIcon node={entry.source} />
            <span className="nt-section-crumb">{entry.containingPageName}</span>
            {entry.source.id !== entry.containingPageId && (
              <span className="nt-section-source">
                {" › "}
                {deriveDisplayName(entry.source) || entry.source.id}
              </span>
            )}
            {entry.kind === "containment" && (
              <span className="nt-section-context">in {entry.containingPageName}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
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

  return (
    <div className="nt-page-sections">
      <Section
        key={`linked-${pageId}`}
        client={client}
        title="Linked references"
        icon={<Icon path="mdi-link-variant" size={0.9} />}
        badge={client.getBacklinkCount(pageId)}
        defaultCollapsed={false}
        load={loadLinkedRefs}
        emptyText="No linked references."
        renderResults={(entries) => <ReferenceList entries={entries} onOpenPage={onOpenPage} />}
      />
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
      <Section
        key={`unlinked-${pageId}`}
        client={client}
        title="Unlinked references"
        icon={<Icon path="mdi-link-off" size={0.9} />}
        load={loadUnlinkedRefs}
        emptyText="No unlinked references."
        renderResults={(entries) => <ReferenceList entries={entries} onOpenPage={onOpenPage} />}
      />
    </div>
  );
}
