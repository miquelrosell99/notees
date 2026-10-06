/**
 * SelectionBar — the floating action bar for the block
 * multi-selection: appears while a page-body selection is live and offers
 * the group ops over the selected rows through the existing client batch
 * paths (one write per selected block):
 *
 * - Assign class… / Unassign class… — a class picker; unassign refuses the
 *   non-removable system classes up front.
 * - Add tag… — a page picker (tags are pages).
 * - Move to page… — reparents every selected block under the picked page.
 * - Delete… — the reusable danger ConfirmationModal, then per-block trash.
 * - × / Escape clears the selection.
 *
 * The bar reads the selection from the OutlinerContext (PageView provides
 * it); pickers stay open for repeated picks only where that makes sense —
 * here each op applies the picked node to the whole set in one gesture and
 * closes the picker.
 */

import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { ConfirmationModal } from "./ui/ConfirmationModal.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { notificationStore } from "./ui/notificationStore.js";
import { classRemovalRefusal } from "./classRemoval.js";
import { useOutliner } from "../outliner-context.js";
import { Icon } from "../Icon.js";

type AnyClient = WorkspaceClient | WorkerClient;

type PickerKind = "assign-class" | "unassign-class" | "tag" | "move";

const PICKER_LABEL: Record<PickerKind, string> = {
  "assign-class": "Assign class",
  "unassign-class": "Unassign class",
  tag: "Add tag",
  move: "Move to page",
};

export function SelectionBar({ client }: { client: AnyClient }) {
  const outliner = useOutliner();
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);

  const ids = [...outliner.selection];
  const count = ids.length;
  // The confirmation must outlive the selection: the bar chrome hides the
  // moment the set empties, but the latched modal keeps rendering until it
  // decides (same latch pattern as the node context menu's delete).
  if (count === 0 && !confirmingDelete) return null;

  /** One write per selected block, sequentially (honest per-block failures). */
  const applyToAll = async (write: (id: string) => Promise<unknown>): Promise<void> => {
    for (const id of ids) {
      await write(id);
    }
  };

  const openPicker = (kind: PickerKind) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    anchorRef.current = event.currentTarget;
    setPicker((current) => (current === kind ? null : kind));
  };

  const handlePick = (nodeId: string): void => {
    const kind = picker;
    setPicker(null);
    if (kind === null) return;
    if (kind === "unassign-class") {
      const refusal = classRemovalRefusal(nodeId);
      if (refusal !== null) {
        notificationStore.warning("Class can't be removed", refusal);
        return;
      }
      void applyToAll((id) => client.unassignClass(id, nodeId)).catch((error: unknown) => {
        console.warn("[selection] bulk unassignClass failed:", error);
      });
      return;
    }
    if (kind === "assign-class") {
      void applyToAll((id) => client.assignClass(id, nodeId)).catch((error: unknown) => {
        console.warn("[selection] bulk assignClass failed:", error);
      });
      return;
    }
    if (kind === "tag") {
      void applyToAll((id) => client.assignTag(id, nodeId)).catch((error: unknown) => {
        console.warn("[selection] bulk assignTag failed:", error);
      });
      return;
    }
    // move: reparent every selected block under the picked page.
    void applyToAll((id) => client.moveObject(id, nodeId)).catch((error: unknown) => {
      console.warn("[selection] bulk move failed:", error);
    });
  };

  return (
    <>
      {count > 0 && (
        <div className="nt-selection-bar" role="toolbar" aria-label="Selection actions">
          <span className="nt-selection-bar__count" aria-live="polite">
            {count} selected
          </span>
          {(Object.keys(PICKER_LABEL) as PickerKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`nt-selection-bar__btn${picker === kind ? " nt-selection-bar__btn--active" : ""}`}
              aria-expanded={picker === kind}
              onClick={openPicker(kind)}
            >
              {PICKER_LABEL[kind]}
            </button>
          ))}
          <button
            type="button"
            className="nt-selection-bar__btn nt-selection-bar__btn--danger"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </button>
          <button
            type="button"
            className="nt-selection-bar__btn nt-selection-bar__btn--icon"
            aria-label="Clear selection"
            title="Clear selection (Esc)"
            onClick={() => outliner.clearSelection()}
          >
            <Icon path="mdi-close" size={0.7} />
          </button>
        </div>
      )}
      {picker !== null && (
        <NodeSelector
          client={client}
          searchMode={picker === "assign-class" || picker === "unassign-class" ? "classes" : "pages"}
          anchorEl={anchorRef.current}
          onClose={() => setPicker(null)}
          searchPlaceholder={
            picker === "assign-class" || picker === "unassign-class"
              ? "Search classes…"
              : picker === "tag"
                ? "Search pages…"
                : "Move to page…"
          }
          onAdd={(node) => handlePick(node.id)}
        />
      )}
      {confirmingDelete && (
        <ConfirmationModal
          isOpen
          variant="danger"
          title={`Delete ${count} block${count > 1 ? "s" : ""}?`}
          message={`The selected block${count > 1 ? "s" : ""} (and their children) move to the trash.`}
          confirmLabel="Delete"
          onConfirm={() =>
            applyToAll((id) => client.deleteObject(id))
              .catch((error: unknown) => {
                console.warn("[selection] bulk delete failed:", error);
              })
              .finally(() => {
                outliner.clearSelection();
                setConfirmingDelete(false);
              })
          }
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </>
  );
}
