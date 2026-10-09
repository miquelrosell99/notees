/**
 * LocalGraphCard — the context column's local graph: the neighborhood
 * around the open page, one component with the
 * full graph (GraphView's `local` scope), depth-selectable. A card, not a
 * peek: it mirrors the main view's node and never edits.
 *
 * Collapsed by default (owner 2026-10-09) and genuinely lazy: the section
 * chrome rides NodeViewSection, which UNMOUNTS its content while collapsed
 * — the GraphView (the graph engine, the WebGL renderer, the topology
 * reads) never mounts, so a collapsed card costs nothing at all. The first
 * expand mounts it; collapsing again tears the whole stack down.
 */

import { useState } from "react";

import type { AnyClient } from "../views/types.js";
import { GraphView } from "../views/graph/GraphView.js";
import { Icon } from "../Icon.js";
import { NodeViewSection } from "./NodeViewSection.js";
import "./LocalGraphCard.css";

export function LocalGraphCard({
  client,
  nodeId,
  onOpenNode,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenNode: (nodeId: string) => void;
}) {
  const [depth, setDepth] = useState(2);
  const [expanded, setExpanded] = useState(false);
  return (
    <NodeViewSection
      title="Local graph"
      icon={<Icon path="mdi-graph-outline" size={0.9} />}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {/* Mounts only on the first expand — the lazy contract above. */}
      <section className="nt-localgraph-card" aria-label="Local graph">
        <GraphView client={client} items={undefined} onNodeClick={onOpenNode} local={{ anchorId: nodeId, depth, onDepthChange: setDepth }} />
      </section>
    </NodeViewSection>
  );
}
