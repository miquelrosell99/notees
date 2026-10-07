/**
 * Right-sidebar context sections → the page chrome's context column:
 * what survives the rail's cards-only
 * rework is the table of contents of the page open in the MAIN view, now
 * riding the panelled layout's third column inside the content card (the
 * rail hosts workspace cards exclusively). TOC derivation lives in
 * ./sidebarToc.ts (tree-derived — no heading tokens exist).
 *
 * The references dedupe check (the layout precondition): the rail's
 * ReferencesSection and the page's own Backlinks tab both rendered
 * getLinkedReferences — the SAME data — so the rail's ReferencesSection is
 * DELETED rather than relocated; the Backlinks tab stays the one home in
 * the SectionStack, where the tab/filter machinery lands later. One home,
 * no duplication.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { clipCrumbName } from "./Breadcrumbs.js";
import { tocEntriesOf } from "./sidebarToc.js";
import "./sidebarSections.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** The table of contents of the main-view page; hidden when it has no entries. */
export function TocSection({
  client,
  pageId,
  activeId,
  onOpenNode,
}: {
  client: AnyClient;
  pageId: string;
  /** The node currently open in the main view — its entry highlights. */
  activeId: string | null;
  onOpenNode: (nodeId: string) => void;
}) {
  const entries = tocEntriesOf(client, pageId);
  if (entries.length === 0) return null;
  return (
    <nav className="nt-rail-toc" aria-label="Table of contents">
      <div className="nt-rail-toc__title">Contents</div>
      <ul className="nt-rail-toc__list">
        {entries.map((entry) => {
          const active = entry.node.id === activeId;
          return (
            <li
              key={entry.node.id}
              className={
                "nt-rail-toc__item" +
                (entry.depth === 1 ? " nt-rail-toc__item--nested" : "") +
                (active ? " nt-rail-toc__item--active" : "")
              }
            >
              <button
                type="button"
                className="nt-rail-toc__entry"
                aria-current={active ? "location" : undefined}
                title={entry.label}
                onClick={() => onOpenNode(entry.node.id)}
              >
                {entry.kind === "page" && client.effectiveNodeIcon(entry.node) !== null && (
                  <Icon
                    path={client.effectiveNodeIcon(entry.node)!}
                    size={0.75}
                    className="nt-rail-toc__icon"
                  />
                )}
                <span className="nt-rail-toc__label">{clipCrumbName(entry.label, 40)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
