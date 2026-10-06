/**
 * SyncDetailsModal (§34.115) — the sync indicator's click target. Shows the
 * engine state and backlog, a force resync (push + pull), and the bounded
 * semantic conflict history (§34.115 — conflicts are otherwise transient:
 * emitted once by the engine, never stored). Composes the ui primitives;
 * live-refreshes the conflict list on worker notifications while open. The
 * status snapshot arrives from the App layer (it already polls on a cadence
 * and on every notification).
 */

import { useCallback, useEffect, useState } from "react";

import type {
  ConflictHistoryEntry,
  SyncStatusSnapshot,
} from "@/core/workspace-client.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { EmptyState } from "../ui/EmptyState.js";
import { Modal } from "../ui/Modal.js";
import { displayNameFromClient } from "../../dateDisplay.js";
import type { AnyClient } from "../Sidebar.js";

import "./SyncDetailsModal.css";

const CONFLICT_LABELS: Record<string, string> = {
  move_move: "Concurrent moves",
  node_deleted: "Edit vs delete",
  class_conflict: "Class assignment clash",
  property_conflict: "Property set vs unset",
};

export function SyncDetailsModal({
  client,
  snapshot,
  isOpen,
  onClose,
}: {
  client: AnyClient;
  snapshot: SyncStatusSnapshot;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [conflicts, setConflicts] = useState<ConflictHistoryEntry[]>([]);
  const [resyncing, setResyncing] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);

  const refreshConflicts = useCallback(() => {
    Promise.resolve(client.conflictHistory())
      .then(setConflicts)
      .catch((error: unknown) => {
        console.error("sync details: conflict history failed:", error);
      });
  }, [client]);

  // Load on open and live-refresh on every worker notification while open.
  useEffect(() => {
    if (!isOpen) return;
    refreshConflicts();
    return client.subscribe(() => {
      if (isOpen) refreshConflicts();
    });
  }, [isOpen, client, refreshConflicts]);

  const resync = () => {
    setResyncing(true);
    setResyncError(null);
    // One push+pull cycle: local backlog out, seq catch-up in.
    client
      .sync()
      .then(() => {
        refreshConflicts();
      })
      .catch((error: unknown) => {
        setResyncError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setResyncing(false);
      });
  };

  const stateBadge =
    snapshot.status === "error" ? (
      <Badge variant="warning">error</Badge>
    ) : snapshot.status === "syncing" ? (
      <Badge variant="primary">syncing</Badge>
    ) : (
      <Badge variant="neutral">idle</Badge>
    );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Sync" size="sm">
      <div className="sync-details">
        <dl className="sync-details-grid">
          <div className="sync-details-row">
            <dt>State</dt>
            <dd>
              {stateBadge}
              {snapshot.realtime ? " · realtime" : " · realtime off"}
            </dd>
          </div>
          <div className="sync-details-row">
            <dt>Backlog</dt>
            <dd>
              {snapshot.pending} pending · {snapshot.failed} failed
            </dd>
          </div>
          {(snapshot.quarantined > 0 || snapshot.parked > 0) && (
            <div className="sync-details-row">
              <dt>Held</dt>
              <dd>
                {snapshot.quarantined > 0 ? `${snapshot.quarantined} quarantined` : null}
                {snapshot.quarantined > 0 && snapshot.parked > 0 ? " · " : null}
                {snapshot.parked > 0 ? `${snapshot.parked} parked` : null}
              </dd>
            </div>
          )}
          <div className="sync-details-row">
            <dt>Server seq</dt>
            <dd>{snapshot.cursorSeq}</dd>
          </div>
          {snapshot.error !== null && (
            <div className="sync-details-row sync-details-row-error">
              <dt>Last error</dt>
              <dd>{snapshot.error}</dd>
            </div>
          )}
        </dl>

        <div className="sync-details-actions">
          <Button variant="primary" onClick={resync} loading={resyncing} disabled={resyncing}>
            {resyncing ? "Resyncing…" : "Resync now"}
          </Button>
          <span className="sync-details-hint">Push, then pull.</span>
        </div>
        {resyncError !== null && <p className="sync-details-error">{resyncError}</p>}

        <h3 className="sync-details-conflicts-heading">Conflicts</h3>
        {conflicts.length === 0 ? (
          <EmptyState
            title="No conflicts"
            description="Semantic conflicts between this device and the relay show up here."
          />
        ) : (
          <ul className="sync-details-conflicts">
            {conflicts
              .slice()
              .reverse()
              .map((conflict, index) => (
                <li key={`${conflict.at}-${index}`} className="sync-details-conflict">
                  <span className="sync-details-conflict-name">
                    {displayNameFromClient(client, conflict.nodeId) ?? conflict.nodeId}
                  </span>
                  <span className="sync-details-conflict-type">
                    {CONFLICT_LABELS[conflict.conflictType] ?? conflict.conflictType}
                  </span>
                  <span className="sync-details-conflict-meta">
                    {new Date(conflict.at).toLocaleString()} · {conflict.localEnvelopeIds.length} local /{" "}
                    {conflict.remoteEnvelopeIds.length} remote ops
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
