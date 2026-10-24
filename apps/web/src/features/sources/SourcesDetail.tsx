/**
 * SourcesDetail — the Sources hub's right pane: the selected source's
 * type-aware detail editor (title, type chip, the Zotero field set through
 * the class bindings, Open + Delete affordances). Task 3 owns the WIRING
 * only: the pane receives the hub's single selection and renders the
 * selected source's title read-only — the type-aware editor lands with the
 * detail task. Nothing selected (or the node is gone) renders the honest
 * empty state.
 */

import { deriveDisplayName } from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";
import { Icon } from "../../ui/Icon.js";
import { EmptyState } from "../../components/ui/fleet/EmptyState.js";
import "./SourcesDetail.css";

export function SourcesDetail({
  client,
  selectedId,
}: {
  client?: AnyClient | undefined;
  /** The hub-owned single selection (null = the honest empty state). */
  selectedId?: string | null | undefined;
}) {
  const node =
    client !== undefined && selectedId !== undefined && selectedId !== null
      ? client.getNode(selectedId)
      : undefined;
  if (node === undefined) {
    return (
      <EmptyState
        icon={<Icon path="mdi-text-box-search-outline" size={2} />}
        title="Select a source"
        description="Pick a source in the list to see its details."
      />
    );
  }
  return (
    <div className="nt-sources-detail">
      <h2 className="nt-sources-detail__title">{deriveDisplayName(node)}</h2>
    </div>
  );
}
