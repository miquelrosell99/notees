/**
 * Right-sidebar context sections → the page chrome's context column:
 * what survives the rail's cards-only
 * rework is the page's table of contents, now
 * riding the panelled layout's third column inside the content card (the
 * rail hosts workspace cards exclusively). TOC derivation lives in
 * ./sidebarToc.ts — heading-token-derived (the `heading` content token,
 * owner 2026-10-12) — and the section rides the STANDARD collapsible
 * section chrome (owner: same UI as the other context sections), named
 * "Table of content", hiding when the page has no heading blocks.
 *
 * The references dedupe check (the layout precondition): the rail's
 * ReferencesSection and the page's own Backlinks section both rendered
 * getLinkedReferences — the SAME data — so the rail's ReferencesSection is
 * DELETED rather than relocated; the Backlinks section stays the one home
 * in the SectionStack — a normal NodeCollection section since the tab
 * strip's retirement (owner 2026-10-09). One home,
 * no duplication.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { Icon } from "../Icon.js";
import { NodeViewSection } from "../../features/page-sections/NodeViewSection.js";
import { clipCrumbName } from "../../features/node-menu/Breadcrumbs.js";
import { tocEntriesOf } from "./sidebarToc.js";
import "./sidebarSections.css";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * The page's table of contents — heading blocks only, standard section
 * chrome; clicking an entry jumps the main view to the block (the host
 * scrolls + flashes it). Hidden when the page has no headings.
 */
export function TocSection({
  client,
  pageId,
  onJumpToBlock,
}: {
  client: AnyClient;
  pageId: string;
  onJumpToBlock: (nodeId: string) => void;
}) {
  const entries = tocEntriesOf(client, pageId);
  if (entries.length === 0) return null;
  return (
    <NodeViewSection
      title="Table of content"
      icon={<Icon path="mdi-table-of-contents" size={0.9} />}
      count={entries.length}
      className="nt-toc"
      defaultExpanded={false}
    >
      <ul className="nt-toc__list">
        {entries.map((entry) => (
          <li
            key={entry.node.id}
            className={
              "nt-toc__item" + (entry.depth === 1 ? " nt-toc__item--nested" : "")
            }
          >
            <button
              type="button"
              className="nt-toc__entry"
              title={entry.label}
              onClick={() => onJumpToBlock(entry.node.id)}
            >
              <span className="nt-toc__label">{clipCrumbName(entry.label, 40)}</span>
            </button>
          </li>
        ))}
      </ul>
    </NodeViewSection>
  );
}
