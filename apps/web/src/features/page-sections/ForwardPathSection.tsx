/**
 * ForwardPathSection — the page's "Forward path" system section
 * (research-tier2 slice 5): the derived directed walk over the node's
 * CONSUMER edges — where the idea went next (embedded-in → synthesis →
 * plan). The FIRST non-query system section: the registry hosts it as a
 * plain `{ key, render }` entry (placement is data), the component owns its
 * read strategy.
 *
 * The SCHEMA.md lazy-loading contract: collapsed by default and a collapsed
 * section executes NO read — the walk (the expensive read; it IS the count,
 * so no eager badge exists either) runs on the first expand through
 * useSectionData (first-activation resolution, cache across collapse,
 * re-derive per client notification while expanded). Rows render one per
 * hop, indented by depth, each labeled by the edge that carried the chain
 * to it ("embedded in" / "mentioned in" / the typed-link verb), and click
 * through to the hop node. The peek-card surface stays collapsed like
 * every other section (the card is a glance) — collapsed is already this
 * section's default, so the prop is accepted for the uniform ctx contract
 * and needs no action.
 */

import { useState } from "react";

import type { PathRow } from "@notees/store";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { titleOfNode } from "../../ui/dateDisplay.js";
import { parentlessBlockResolverOf } from "../../ui/renderStateLabel.js";
import { useSectionData } from "../collection/useSectionData.js";
import { NodeViewSection } from "./NodeViewSection.js";
import "./ForwardPathSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Arrival label: how the previous chain node's edge leads to this hop. */
function arrivalLabelOf(prev: PathRow): string {
  if (prev.kind === "embed") return "embedded in";
  if (prev.kind === "mention") return "mentioned in";
  return prev.verb !== null ? `via ${prev.verb}` : "linked";
}

export function ForwardPathSection({
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
  const [expanded, setExpanded] = useState(false);
  // The lazy contract: active only while expanded — a collapsed section
  // runs no query; the resolution caches across collapse/expand at an
  // unchanged notification version.
  const { rows: paths } = useSectionData<PathRow[][]>({
    client,
    active: expanded,
    read: () => client.getForwardPaths(pageId),
  });

  const titleOf = (id: string): string => {
    const node: ClientNode | undefined = client.getNode(id);
    if (node === undefined) return "untitled";
    return titleOfNode(node, {
      empty: "untitled",
      isParentlessBlockClass: parentlessBlockResolverOf(client),
    });
  };

  return (
    <NodeViewSection
      title="Forward path"
      icon={<Icon path="mdi-ray-start-arrow" size={0.9} />}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {paths === null ? null : paths.length === 0 ? (
        <p className="nt-forward-path__empty">No forward paths.</p>
      ) : (
        <ul className="nt-forward-path__list">
          {paths.flatMap((path, pathIndex) =>
            // Row 0 is the anchor (the page itself) — the hops follow.
            path.slice(1).map((row, i) => (
              <li
                key={`${pathIndex}-${i}-${row.nodeId}`}
                className="nt-forward-path__row"
                style={{ paddingInlineStart: `${i + 1}em` }}
              >
                <span className="nt-forward-path__kind">{arrivalLabelOf(path[i]!)}</span>
                <button
                  type="button"
                  className="nt-forward-path__node"
                  onClick={() => onOpenPage?.(row.nodeId)}
                >
                  {titleOf(row.nodeId)}
                </button>
              </li>
            )),
          )}
        </ul>
      )}
    </NodeViewSection>
  );
}
