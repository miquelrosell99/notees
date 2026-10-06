/**
 * Selection export — the cards/kanban counterpart of the table's row
 * selection ("selection export beyond tables"). One session-local selection
 * state + one export affordance
 * shared by every flat collection view:
 *
 *  - `useViewSelection` — the picked-id set + toggle/clear (session state,
 *    exactly the table's contract — never an op).
 *  - `SelectionExportControls` — the live-selection chrome (count + "Export
 *    selected…") opening the standard ExportPageModal batch path with
 *    nodeUuids = the checked ids — the SAME affordance the table toolbar
 *    has, so every view exports its selection identically.
 *
 * Views opting out pass `selectable={false}` (the tables' precedent).
 */

import { useState, type ReactNode } from "react";

import { Button } from "../components/ui/index.js";
import { ExportPageModal } from "../components/modals/ExportPageModal.js";
import type { AnyClient } from "./types.js";

export interface ViewSelection {
  selected: ReadonlySet<string>;
  isSelected: (nodeId: string) => boolean;
  toggle: (nodeId: string) => void;
  clear: () => void;
}

/** Session-local selection state (the table's row-selection contract). */
export function useViewSelection(): ViewSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return {
    selected,
    isSelected: (nodeId) => selected.has(nodeId),
    toggle: (nodeId) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      }),
    clear: () => setSelected(new Set()),
  };
}

/**
 * The live-selection chrome: "N selected" + the Export selected… button
 * (the ExportPageModal batch path over exactly the checked ids). Renders
 * nothing at zero — a quiet surface until a selection exists, like the
 * table toolbar.
 */
export function SelectionExportControls({
  client,
  selection,
}: {
  client: AnyClient;
  selection: ViewSelection;
}): ReactNode {
  const [exporting, setExporting] = useState(false);
  if (selection.selected.size === 0) return null;
  return (
    <span className="selection-export">
      <span className="selection-export__count">{selection.selected.size} selected</span>
      <Button
        variant="ghost"
        size="sm"
        icon="mdi mdi-export"
        onClick={() => setExporting(true)}
      >
        Export selected…
      </Button>
      {exporting && (
        <ExportPageModal
          isOpen
          onClose={() => setExporting(false)}
          client={client}
          nodeUuids={[...selection.selected]}
        />
      )}
    </span>
  );
}
