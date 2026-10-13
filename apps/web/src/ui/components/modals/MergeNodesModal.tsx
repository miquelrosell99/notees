/**
 * MergeNodesModal - Merge the currently open page into another page.
 *
 * The source page is fixed (it is the page the user is on); the target is
 * picked from the pages-only NodeSelector (anchored at the target field, the
 * source excluded). Proceed asks a danger ConfirmationModal naming both
 * titles, then runs client.mergeNodes — the planner's guard errors surface
 * in this modal as an error line and it stays open. On success the merge is
 * already applied + synced by the client; the host navigates to the target.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { ConfirmationModal } from "../ui/ConfirmationModal.js";
import { NodeIcon } from "./NodeIcon";
import { NodeSelector } from "../pickers/NodeSelector.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";
import { displayNameForSettings } from "../../dateDisplay.js";
import "./MergeNodesModal.css";

export interface MergeNodesModalProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** The workspace data surface the merge writes through. */
  client: WorkspaceClient;
  /** The source page (the currently open page) — merged INTO the target. */
  sourceId: string;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback when the merge completed; the host navigates to the target. */
  onMerged: (targetId: string) => void;
}

export function MergeNodesModal({
  isOpen,
  client,
  sourceId,
  onClose,
  onMerged,
}: MergeNodesModalProps) {
  const [target, setTarget] = useState<ClientNode | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetButtonRef = useRef<HTMLButtonElement>(null);

  // Reset state when the modal opens.
  useEffect(() => {
    if (isOpen) {
      setTarget(null);
      setPickerOpen(false);
      setConfirmOpen(false);
      setIsMerging(false);
      setError(null);
    }
  }, [isOpen]);

  const source = client.getNode(sourceId);
  const sourceTitle = (source !== undefined && displayNameForSettings(source)) || "Untitled";
  const targetTitle = (target !== null && displayNameForSettings(target)) || "Untitled";

  const handleClose = useCallback(() => {
    setTarget(null);
    setPickerOpen(false);
    setConfirmOpen(false);
    setError(null);
    onClose();
  }, [onClose]);

  const handleMerge = useCallback(async () => {
    if (target === null) return;
    setIsMerging(true);
    setError(null);
    try {
      await client.mergeNodes(sourceId, target.id);
      onMerged(target.id);
      handleClose();
    } catch (err: unknown) {
      // The guard (MergeGuardError) and any apply failure surface here and
      // the modal stays open — back out of the confirmation to the merge
      // dialog with the error line.
      setError(err instanceof Error ? err.message : "Merge failed. Please try again.");
      setConfirmOpen(false);
    } finally {
      setIsMerging(false);
    }
  }, [target, client, sourceId, onMerged, handleClose]);

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title={`Merge "${sourceTitle}" into…`}
        size="sm"
        footer={
          <div className="merge-nodes-modal__footer">
            <Button variant="ghost" onClick={handleClose} size="sm">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => setConfirmOpen(true)}
              size="sm"
              disabled={target === null || isMerging}
            >
              Proceed
            </Button>
          </div>
        }
      >
        <div className="merge-nodes-modal">
          <p className="merge-nodes-modal__description">
            Merging moves <strong>{sourceTitle}</strong>&apos;s blocks and child pages into the
            target, remaps classes, properties, and links that point at{" "}
            <strong>{sourceTitle}</strong>, and trashes <strong>{sourceTitle}</strong>.
          </p>

          <div className="merge-nodes-modal__target-row">
            <span className="merge-nodes-modal__target-label">Into</span>
            <button
              ref={targetButtonRef}
              type="button"
              className="merge-nodes-modal__target"
              onClick={() => setPickerOpen(true)}
            >
              {target !== null ? (
                <>
                  <NodeIcon icon={target.icon} isPage size="sm" />
                  <span className="merge-nodes-modal__target-name">
                    {displayNameForSettings(target) || "Untitled"}
                  </span>
                </>
              ) : (
                <span className="merge-nodes-modal__target-placeholder">Pick a target page…</span>
              )}
            </button>
          </div>

          {error && (
            <p className="merge-nodes-modal__error" role="alert">
              {error}
            </p>
          )}
        </div>
      </Modal>

      {pickerOpen && targetButtonRef.current !== null && (
        <NodeSelector
          client={client}
          searchMode="pages"
          noCreate
          excludeNodeId={sourceId}
          anchorEl={targetButtonRef.current}
          onClose={() => setPickerOpen(false)}
          searchPlaceholder="Search pages…"
          onAdd={(picked) => {
            setTarget(picked);
            setPickerOpen(false);
          }}
        />
      )}

      <ConfirmationModal
        isOpen={confirmOpen}
        title="Merge pages?"
        message={`This will move everything from "${sourceTitle}" into "${targetTitle}" and trash "${sourceTitle}".`}
        confirmLabel="Merge"
        variant="danger"
        onConfirm={handleMerge}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
