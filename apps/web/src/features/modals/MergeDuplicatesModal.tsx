/**
 * MergeDuplicatesModal — merge one duplicate cluster (task 12's
 * groupSourceDuplicates group) into a single kept source.
 *
 * The target picker is a DROPDOWN of the GROUP'S MEMBERS (the owner
 * requirement — NOT the free NodeSelector; the answer always lies inside
 * the cluster), defaulting to the first member. A dry-run summary (the
 * MergePlanSummary counts, aggregated over the losers) renders before
 * confirming; confirm asks the danger ConfirmationModal naming the kept
 * source and stating the losers go to TRASH, then runs the STANDARD merge
 * semantics — the same planMerge legs MergeNodesModal rides (children
 * move, classes/tags/properties/links remap or copy into empty slots, the
 * losers trash LAST).
 *
 * Wiring per client mode: the in-process WorkspaceClient plans + applies
 * locally (`planMergeSummary` for the preview, `mergeNodes` for the merge —
 * one undo batch per loser); the worker client rides the server merge
 * route (`mergeNodesRemote` — `?dryRun=true` for the preview) and pulls
 * afterwards so the local projection catches up. Guard failures surface
 * as an error line and the modal stays open (the MergeNodesModal pattern).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MergePlanSummary } from "@notees/store";

import { Modal } from "../../components/ui/kit/Modal.js";
import { Button } from "../../components/ui/kit/Button.js";
import { ConfirmationModal } from "../../components/ui/kit/ConfirmationModal.js";
import { Dropdown } from "../../components/ui/kit/Dropdown.js";
import type { AnyClient } from "../../ui/app/clients.js";
import { WorkspaceClient } from "@/core/workspace-client/index.js";
import type { SourceDuplicateGroup } from "../sources/duplicates.js";
import "./MergeDuplicatesModal.css";

export interface MergeDuplicatesModalProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** The workspace data surface the merge writes through (mode-picked). */
  client: AnyClient;
  /** The duplicate cluster — every member is a merge target candidate. */
  group: SourceDuplicateGroup;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback when the merge completed; the host refreshes the view. */
  onMerged: () => void;
}

/** The MergePlanSummary keys with their singular/plural display labels. */
const SUMMARY_LABELS: readonly (readonly [keyof MergePlanSummary, string, string])[] = [
  ["childrenMoved", "child moved", "children moved"],
  ["classesRemapped", "class remapped", "classes remapped"],
  ["tagsRemapped", "tag remapped", "tags remapped"],
  ["propertiesCopied", "property copied", "properties copied"],
  ["propertiesSkipped", "property skipped", "properties skipped"],
  ["contentLinksRewritten", "content link rewritten", "content links rewritten"],
  ["propertyValuesRewritten", "property value rewritten", "property values rewritten"],
  ["standaloneChildrenRelocated", "block relocated", "blocks relocated"],
  ["aliasesRepointed", "alias repointed", "aliases repointed"],
  ["collectionsRemapped", "collection remapped", "collections remapped"],
  ["fieldsCopied", "field copied", "fields copied"],
];

function zeroSummary(): MergePlanSummary {
  return {
    childrenMoved: 0,
    classesRemapped: 0,
    tagsRemapped: 0,
    propertiesCopied: 0,
    propertiesSkipped: 0,
    contentLinksRewritten: 0,
    propertyValuesRewritten: 0,
    standaloneChildrenRelocated: 0,
    aliasesRepointed: 0,
    collectionsRemapped: 0,
    fieldsCopied: 0,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Merge failed. Please try again.";
}

export function MergeDuplicatesModal({
  isOpen,
  client,
  group,
  onClose,
  onMerged,
}: MergeDuplicatesModalProps) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [summary, setSummary] = useState<MergePlanSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the modal opens (the MergeNodesModal idiom).
  useEffect(() => {
    if (isOpen) {
      setTargetId(group.members[0]?.id ?? null);
      setSummary(null);
      setSummaryError(null);
      setConfirmOpen(false);
      setIsMerging(false);
      setError(null);
    }
  }, [isOpen, group]);

  const losers = useMemo(
    () => group.members.filter((member) => member.id !== targetId),
    [group, targetId],
  );
  const target = group.members.find((member) => member.id === targetId) ?? null;

  // The dry-run summary: per loser, the plan against the picked target —
  // local planner in-process, the server's ?dryRun=true route in worker
  // mode — aggregated into one count set. A guard failure here means the
  // merge WOULD fail: it surfaces as the error line and blocks confirm.
  useEffect(() => {
    if (!isOpen || targetId === null) return;
    let cancelled = false;
    setSummary(null);
    setSummaryError(null);
    void (async () => {
      try {
        const total = zeroSummary();
        for (const loser of group.members.filter((member) => member.id !== targetId)) {
          const one =
            client instanceof WorkspaceClient
              ? client.planMergeSummary(loser.id, targetId)
              : await client.mergeNodesRemote(loser.id, targetId, true);
          for (const [key] of SUMMARY_LABELS) total[key] += one[key];
        }
        if (!cancelled) setSummary(total);
      } catch (err: unknown) {
        if (!cancelled) setSummaryError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, targetId, client, group]);

  const handleClose = useCallback(() => {
    setConfirmOpen(false);
    setError(null);
    onClose();
  }, [onClose]);

  const handleMerge = useCallback(async () => {
    if (targetId === null) return;
    setIsMerging(true);
    setError(null);
    try {
      for (const loser of losers) {
        if (client instanceof WorkspaceClient) {
          // One undo-journal batch per loser (the planner's contract).
          await client.mergeNodes(loser.id, targetId);
        } else {
          await client.mergeNodesRemote(loser.id, targetId, false);
        }
      }
      if (!(client instanceof WorkspaceClient)) {
        // The route wrote server-side; pull so the local projection (and
        // the duplicates view over it) catches up.
        await client.pull();
      }
      onMerged();
      handleClose();
    } catch (err: unknown) {
      // The guard and any apply/transport failure surface here and the
      // modal stays open — back out of the confirmation to the merge
      // dialog with the error line (the MergeNodesModal pattern).
      setError(errorMessage(err));
      setConfirmOpen(false);
    } finally {
      setIsMerging(false);
    }
  }, [targetId, losers, client, onMerged, handleClose]);

  const summaryText =
    summary !== null
      ? (SUMMARY_LABELS.filter(([key]) => summary[key] > 0)
          .map(([key, singular, plural]) => `${summary[key]} ${summary[key] === 1 ? singular : plural}`)
          .join(" · ") ||
        "Nothing to move — the other copies merge away as-is.")
      : null;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title={`Merge ${group.members.length} duplicates`}
        size="sm"
        footer={
          <div className="merge-duplicates-modal__footer">
            <Button variant="ghost" onClick={handleClose} size="sm">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => setConfirmOpen(true)}
              size="sm"
              disabled={targetId === null || isMerging || summary === null || summaryError !== null}
            >
              Merge
            </Button>
          </div>
        }
      >
        <div className="merge-duplicates-modal">
          <p className="merge-duplicates-modal__description">
            Merging moves every other copy&apos;s children, classes, properties, and links into the
            kept source — filling only empty fields — and sends the merged copies to the trash.
          </p>

          <div className="merge-duplicates-modal__target-row">
            <span className="merge-duplicates-modal__target-label">Keep</span>
            <Dropdown
              ariaLabel="Merge target"
              className="merge-duplicates-modal__target-dropdown"
              options={group.members.map((member) => ({ value: member.id, label: member.title }))}
              value={targetId}
              onChange={(value) => setTargetId(value)}
            />
          </div>

          {summaryText !== null && (
            <p className="merge-duplicates-modal__summary">{summaryText}</p>
          )}

          {(summaryError !== null || error !== null) && (
            <p className="merge-duplicates-modal__error" role="alert">
              {summaryError ?? error}
            </p>
          )}
        </div>
      </Modal>

      <ConfirmationModal
        isOpen={confirmOpen}
        title="Merge duplicates?"
        message={`This will merge ${losers.length} duplicate ${losers.length === 1 ? "source" : "sources"} into "${target?.title ?? ""}" and send ${losers.length === 1 ? "it" : "them"} to the trash.`}
        confirmLabel="Merge"
        variant="danger"
        onConfirm={handleMerge}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
