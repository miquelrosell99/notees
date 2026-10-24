/**
 * SourcesDetail — the Sources hub's right pane: the selected source's
 * type-aware detail editor (title, type chip, the Zotero field set through
 * the class bindings, Open + Delete affordances). Task 1 ships the pane's
 * honest empty state only — the editor lands with the hub's detail task.
 */

import { Icon } from "../../ui/Icon.js";
import { EmptyState } from "../../components/ui/fleet/EmptyState.js";

export function SourcesDetail() {
  return (
    <EmptyState
      icon={<Icon path="mdi-text-box-search-outline" size={2} />}
      title="Select a source"
      description="Pick a source in the list to see its details."
    />
  );
}
