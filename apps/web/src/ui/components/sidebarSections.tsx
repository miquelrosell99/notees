/**
 * Right-sidebar context sections (§34.27 L3, modelling decision 4): the
 * table of contents + linked references of the page open in the MAIN view,
 * rendered above the peek-card stack. The rail is chrome — the collapsed
 * system sections at the card bottom stay the small-viewport fallback, and
 * the references section keeps the lazy-loading contract (a collapsed
 * section runs no query; the badge reads the materialized backlink count).
 *
 * TOC derivation lives in ./sidebarToc.ts (tree-derived per D4 — no heading
 * tokens exist); references reuse the linked-references read the bottom
 * section uses, promoted into the rail when the panel is open (B2).
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { ReferenceEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { Section } from "../Section.js";
import { displayNameForSettings } from "../dateDisplay.js";
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

/** One compact reference row: the source's name + its containing page. */
function ReferenceRow({
  entry,
  onOpenNode,
}: {
  entry: ReferenceEntry;
  onOpenNode: (nodeId: string) => void;
}) {
  const name = clipCrumbName(displayNameForSettings(entry.source), 48);
  return (
    <li className="nt-rail-ref__item">
      <button
        type="button"
        className="nt-rail-ref__row"
        title={entry.containingPageName}
        onClick={() => onOpenNode(entry.source.id)}
      >
        <span className="nt-rail-ref__name">{name}</span>
        {entry.source.id !== entry.containingPageId && (
          <span className="nt-rail-ref__context">{clipCrumbName(entry.containingPageName, 24)}</span>
        )}
      </button>
    </li>
  );
}

/**
 * Linked references of the main-view page, promoted into the rail (B2).
 * Hidden at zero backlinks (owner rule); the query itself stays lazy —
 * the section runs it only on first expand, per the system-section contract.
 */
export function ReferencesSection({
  client,
  pageId,
  onOpenNode,
}: {
  client: AnyClient;
  pageId: string;
  onOpenNode: (nodeId: string) => void;
}) {
  const backlinkCount = client.getBacklinkCount(pageId);
  if (backlinkCount === 0) return null;
  return (
    <Section
      key={`rail-refs-${pageId}`}
      client={client}
      title="References"
      icon={<Icon path="mdi-link-variant" size={0.9} />}
      badge={backlinkCount}
      defaultCollapsed
      load={() => client.getLinkedReferences(pageId)}
      emptyText="No linked references."
      renderResults={(entries) => (
        <ul className="nt-rail-ref__list">
          {entries.map((entry) => (
            <ReferenceRow key={entry.source.id} entry={entry} onOpenNode={onOpenNode} />
          ))}
        </ul>
      )}
    />
  );
}
