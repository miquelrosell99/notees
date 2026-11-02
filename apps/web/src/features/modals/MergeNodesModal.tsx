/**
 * MergeNodesModal — the unified multi-source merge dialog: ANY non-class
 * node folds into a picked target (the planner's guards refuse classes,
 * missing/trashed nodes, self-merges, subtree targets, and non-empty
 * collections — a guard failure surfaces as the error line and the modal
 * stays open).
 *
 * Sources ride a pill-row NodeSelector (searchMode "all" + Main/Blocks
 * scope tabs — pages and blocks alike); `initialSourceIds` pre-seeds the
 * row (the palette's "Merge current page into…" and the context menu's
 * "Merge into…" gestures). The target is picked from the same all-mode
 * candidate set, anchored at the target field; each picker excludes the
 * other side via `canAdd`. While at least one source and the target are
 * picked, a live dry-run summary aggregates the per-source plans — the
 * MergeDuplicatesModal pattern, shared through mergeSummary/mergeClient so
 * both store modes (in-process WorkspaceClient, worker WorkerClient) ride
 * the same seams. Confirm is the danger ConfirmationModal naming the
 * sources and the target; the apply loop merges every source sequentially
 * (each trashed, children/classes/properties/links remapped into the
 * target), then ONE pull in worker mode. On success the host navigates to
 * the target.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MergePlanSummary } from "@notees/store";

import { Modal } from "../../components/ui/kit/Modal.js";
import { Button } from "../../components/ui/kit/Button.js";
import { ConfirmationModal } from "../../components/ui/kit/ConfirmationModal.js";
import { NodeIcon } from "./NodeIcon.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import type { ClientNode } from "@/core/workspace-client/index.js";
import type { AnyClient } from "../../ui/app/clients.js";
import { titleOfNode } from "../../ui/dateDisplay.js";
import { summarizeMerge, summaryLineOf, mergeErrorMessage } from "./mergeSummary.js";
import { previewMerge, applyMerge, pullIfRemote } from "./mergeClient.js";
import "./MergeNodesModal.css";

export interface MergeNodesModalProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** The workspace data surface the merge writes through (mode-picked). */
  client: AnyClient;
  /** Pre-seeded merge sources (validated: missing/trashed/class ids drop). */
  initialSourceIds?: string[] | undefined;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback when the merge completed; the host navigates to the target. */
  onMerged: (targetId: string) => void;
}

/** How many source titles the confirmation message names before capping. */
const CONFIRM_TITLE_CAP = 3;

export function MergeNodesModal({
  isOpen,
  client,
  initialSourceIds = undefined,
  onClose,
  onMerged,
}: MergeNodesModalProps) {
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [target, setTarget] = useState<ClientNode | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [summary, setSummary] = useState<MergePlanSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetButtonRef = useRef<HTMLButtonElement>(null);

  // Reset state when the modal opens; the seed ids are validated against
  // the projection (a missing/trashed/class node merges nothing — drop it).
  useEffect(() => {
    if (isOpen) {
      const seen = new Set<string>();
      const seeded: string[] = [];
      for (const id of initialSourceIds ?? []) {
        if (seen.has(id)) continue;
        const node = client.getNode(id);
        if (node === undefined || node.isClass) continue;
        seen.add(id);
        seeded.push(id);
      }
      setSourceIds(seeded);
      setTarget(null);
      setPickerOpen(false);
      setSummary(null);
      setSummaryError(null);
      setConfirmOpen(false);
      setIsMerging(false);
      setError(null);
    }
  }, [isOpen, initialSourceIds, client]);

  const targetId = target?.id ?? null;
  const sourceIdSet = useMemo(() => new Set(sourceIds), [sourceIds]);

  // Cross-exclusions: each picker offers only nodes the other side can
  // still take (never classes, never an already-picked id).
  const canAddSource = (node: ClientNode): boolean =>
    !node.isClass && node.id !== targetId && !sourceIdSet.has(node.id);
  const canAddTarget = (node: ClientNode): boolean =>
    !node.isClass && !sourceIdSet.has(node.id);

  const sourceNodes = sourceIds
    .map((id) => client.getNode(id))
    .filter((node): node is ClientNode => node !== undefined && !node.isClass);
  const sourceTitles = sourceNodes.map((node) => titleOfNode(node) || "Untitled");
  const targetTitle = (target !== null && titleOfNode(target)) || "Untitled";

  // The live dry-run: per source, the plan against the picked target —
  // local planner in-process, the server's ?dryRun=true route in worker
  // mode — aggregated into one count set. A guard failure here means the
  // merge WOULD fail: it surfaces as the error line and blocks the Merge
  // button (the MergeDuplicatesModal pattern).
  useEffect(() => {
    if (!isOpen || sourceIds.length === 0 || targetId === null) return;
    let cancelled = false;
    setSummary(null);
    setSummaryError(null);
    void (async () => {
      try {
        const summaries = await Promise.all(
          sourceIds.map((sourceId) => previewMerge(client, sourceId, targetId)),
        );
        if (!cancelled) setSummary(summarizeMerge(summaries));
      } catch (err: unknown) {
        if (!cancelled) setSummaryError(mergeErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, sourceIds, targetId, client]);

  const handleClose = useCallback(() => {
    setConfirmOpen(false);
    setError(null);
    onClose();
  }, [onClose]);

  const handleMerge = useCallback(async () => {
    if (target === null) return;
    setIsMerging(true);
    setError(null);
    try {
      for (const sourceId of sourceIds) {
        await applyMerge(client, sourceId, target.id);
      }
      await pullIfRemote(client);
      onMerged(target.id);
      handleClose();
    } catch (err: unknown) {
      // The guard and any apply/transport failure surface here and the
      // modal stays open — back out of the confirmation to the merge
      // dialog with the error line.
      setError(mergeErrorMessage(err));
      setConfirmOpen(false);
    } finally {
      setIsMerging(false);
    }
  }, [target, sourceIds, client, onMerged, handleClose]);

  const title =
    sourceIds.length === 0
      ? "Merge nodes into…"
      : `Merge ${sourceIds.length} ${sourceIds.length === 1 ? "node" : "nodes"} into…`;

  // The danger confirmation names the sources (capped sanely) and the target.
  const namedTitles = sourceTitles.slice(0, CONFIRM_TITLE_CAP);
  const moreCount = sourceTitles.length - namedTitles.length;
  const sourcesPhrase =
    namedTitles.map((name) => `"${name}"`).join(", ") +
    (moreCount > 0 ? `, and ${moreCount} more` : "");

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title={title}
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
              disabled={
                sourceIds.length === 0 ||
                target === null ||
                isMerging ||
                summary === null ||
                summaryError !== null
              }
            >
              Merge
            </Button>
          </div>
        }
      >
        <div className="merge-nodes-modal">
          <p className="merge-nodes-modal__description">
            Merging moves every source&apos;s children, classes, properties, and links into the
            target — filling only empty fields — and sends the merged sources to the trash.
          </p>

          <div className="merge-nodes-modal__sources-row">
            <span className="merge-nodes-modal__sources-label">Sources</span>
            <NodeSelector
              trigger="pill-row"
              client={client}
              searchMode="all"
              scopeTabs
              noCreate
              value={sourceIds}
              emptyText="Add source"
              searchPlaceholder="Search nodes…"
              canAdd={canAddSource}
              onAdd={(node) => setSourceIds((prev) => [...prev, node.id])}
              onRemove={(node) =>
                setSourceIds((prev) => prev.filter((id) => id !== node.id))
              }
            />
          </div>

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
                    {titleOfNode(target) || "Untitled"}
                  </span>
                </>
              ) : (
                <span className="merge-nodes-modal__target-placeholder">Pick a target…</span>
              )}
            </button>
          </div>

          {summary !== null && (
            <p className="merge-nodes-modal__summary">{summaryLineOf(summary)}</p>
          )}

          {(summaryError !== null || error !== null) && (
            <p className="merge-nodes-modal__error" role="alert">
              {summaryError ?? error}
            </p>
          )}
        </div>
      </Modal>

      {pickerOpen && targetButtonRef.current !== null && (
        <NodeSelector
          client={client}
          searchMode="all"
          scopeTabs
          noCreate
          canAdd={canAddTarget}
          anchorEl={targetButtonRef.current}
          onClose={() => setPickerOpen(false)}
          searchPlaceholder="Search nodes…"
          onAdd={(picked) => {
            setTarget(picked);
            setPickerOpen(false);
          }}
        />
      )}

      <ConfirmationModal
        isOpen={confirmOpen}
        title="Merge nodes?"
        message={`This will merge ${sourceIds.length} ${sourceIds.length === 1 ? "node" : "nodes"} — ${sourcesPhrase} — into "${targetTitle}" and send ${sourceIds.length === 1 ? "it" : "them"} to the trash.`}
        confirmLabel="Merge"
        variant="danger"
        onConfirm={handleMerge}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
