/**
 * PivotView — the pivot as a first-class registry view mode: every node
 * collection (a hub, a class's members, a page's child blocks, the Created
 * section) can wear the 2D group-by grid, not only query results. The view
 * maps the collection's items INTO the shared engine's minimal PivotRow
 * (id + the two render-state bits — the ClientNode carries them) and
 * renders the shared PivotGrid shell; the grouping semantics (dimensions,
 * measures, the 20-distinct cap, the "Other" bucket, effective values) are
 * the engine's and identical on every surface. The mode needs no
 * availability gating — every set can count (the class bit alone is a
 * dimension).
 */

import { PivotGrid } from "./PivotGrid.js";
import { registerView } from "../registry.js";
import type { NodeCollectionProps } from "../types.js";

export function PivotView({ client, items }: NodeCollectionProps) {
  const rows = (items ?? []).map((item) => ({
    id: item.node.id,
    isClass: item.node.isClass,
    isEmbedded: item.node.isEmbedded,
  }));
  return <PivotGrid client={client} rows={rows} />;
}

registerView({
  id: "pivot",
  label: "Pivot",
  icon: "mdi-table-pivot",
  component: PivotView,
  tier: "secondary",
  capabilities: {},
});
