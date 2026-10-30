/**
 * SelectionBar — the floating action bar for the block
 * multi-selection: appears while a page-body selection is live and offers
 * the group ops over the selected rows — every gesture composes ONE op set
 * for the whole selection and applies it as a single `applyOps` batch (one
 * undo entry, one RPC):
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
import type { ClientWriteOp, WorkspaceClient } from "@/core/workspace-client/index.js";

import { ConfirmationModal } from "../../components/ui/kit/ConfirmationModal.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { notificationStore } from "../../components/ui/kit/notificationStore.js";
import { classRemovalRefusal, planRemoveClassDissolvingLinkOps } from "../metadata/classRemoval.js";
import { useOutliner } from "../../ui/outliner-context.js";
import { Icon } from "../../ui/Icon.js";

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

  /**
   * The whole gesture as ONE batch: one op set per selected block composes
   * into a single `applyOps` call — ONE undo entry ("Undo <verb>"), one RPC
   * on the worker client. (The per-block awaited loop this replaces could
   * fail mid-way leaving partial state with separate undo entries — the
   * batch is strictly better.)
   */
  const applyToAll = (ops: ClientWriteOp[], verb: string): Promise<void> =>
    client.applyOps(ops, { verb }).then(() => undefined);

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
      // The per-node dissolve reads happen here, BEFORE the batch: op
      // composition takes the pre-gesture state.
      const ops = ids.flatMap((id) => planRemoveClassDissolvingLinkOps(client, id, nodeId));
      void applyToAll(ops, "unassign class").catch((error: unknown) => {
        console.warn("[selection] bulk unassignClass failed:", error);
      });
      return;
    }
    if (kind === "assign-class") {
      const ops: ClientWriteOp[] = ids.map((id) => ({ kind: "assignClass", id, classId: nodeId }));
      void applyToAll(ops, "assign class").catch((error: unknown) => {
        console.warn("[selection] bulk assignClass failed:", error);
      });
      return;
    }
    if (kind === "tag") {
      const ops: ClientWriteOp[] = ids.map((id) => ({ kind: "assignTag", id, tagId: nodeId }));
      void applyToAll(ops, "assign tag").catch((error: unknown) => {
        console.warn("[selection] bulk assignTag failed:", error);
      });
      return;
    }
    // move: reparent every selected block under the picked page.
    const ops: ClientWriteOp[] = ids.map((id) => ({ kind: "move", id, parentId: nodeId }));
    void applyToAll(ops, "move").catch((error: unknown) => {
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
            applyToAll(
              ids.map((id) => ({ kind: "delete", id }) as ClientWriteOp),
              "delete",
            )
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
