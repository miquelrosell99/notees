/**
 * LocalGraphCard — the right-rail local graph (§34.30 V8, the parked §34.80
 * follow-up): the neighborhood around the open page, one component with the
 * full graph (GraphView's `local` scope), depth-selectable. A card, not a
 * peek: it mirrors the main view's node and never edits.
 */

import { useState } from "react";

import type { AnyClient } from "../views/types.js";
import { GraphView } from "../views/graph/GraphView.js";
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
  return (
    <section className="nt-localgraph-card" aria-label="Local graph">
      <GraphView client={client} items={undefined} onNodeClick={onOpenNode} local={{ anchorId: nodeId, depth, onDepthChange: setDepth }} />
    </section>
  );
}
