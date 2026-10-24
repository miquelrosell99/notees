/**
 * SourcesFacets — the Sources hub's left pane: the source-type facet list
 * (one row per enabled type with its live count, the archived types dimmed
 * under a collapsed "Hidden types" group). Task 1 ships the pane's honest
 * empty state only — the facet data lands with the hub's data layer.
 */

import { Icon } from "../../ui/Icon.js";
import { EmptyState } from "../../components/ui/fleet/EmptyState.js";

export function SourcesFacets() {
  return (
    <EmptyState
      icon={<Icon path="mdi-shape-outline" size={2} />}
      title="No source types"
      description="Source types with items in the library appear here, with live counts."
    />
  );
}
