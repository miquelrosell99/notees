/**
 * TrashHub — the Trash hub behind the sidebar's Trash entry (owner
 * 2026-10-14): the v1 sidebar's Trash browsing surface, restored for the
 * web UI. The data path was already complete end-to-end (object.delete →
 * the derived `trash` table; `object.restore` a first-class convergent op;
 * the CLI had `object restore`) — what was missing was the web surface:
 * `client.listTrashed()` / `client.restoreObject()` and this hub.
 *
 * Rows are soft-trashed subtree roots, newest first, each with a relative
 * deletion stamp and two actions: Restore (the object.restore op) and
 * Delete permanently (object.delete permanent — irreversible, behind the
 * ConfirmationModal). The header row carries an Empty trash action — one
 * trash.empty op (apply-time bulk permanent delete: a concurrent restore
 * that lands before it survives), confirmed like the per-row permanent
 * delete. The hub re-renders on client notifications, so a restore lands
 * the row back in the workspace immediately.
 */

import { useEffect, useState } from "react";

import { deriveDisplayName } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { TrashedEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { nodeIcon } from "../iconFor.js";
import { relativeTime } from "./ActivityLogSection.js";
import { Button } from "./ui/Button.js";
import { ConfirmationModal } from "./ui/ConfirmationModal.js";
import { EmptyState } from "./ui/EmptyState.js";
import "./TrashHub.css";

type AnyClient = WorkspaceClient | WorkerClient;

export function TrashHub({
  client,
  onOpenNode,
}: {
  client: AnyClient;
  /** Post-restore navigation (the restore action opens the revived node). */
  onOpenNode: (nodeId: string) => void;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const [permanentTarget, setPermanentTarget] = useState<TrashedEntry | null>(null);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);

  const entries = client.listTrashed();

  return (
    <div className="nt-hub nt-trash-hub">
      <header className="nt-hub-header">
        <Icon path="mdi-delete-outline" size={1.2} className="nt-hub-icon" />
        <h1 className="nt-hub-title">Trash</h1>
        <span className="nt-hub-count">{entries.length}</span>
        {entries.length > 0 && (
          <span className="nt-hub-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="mdi-delete-sweep-outline"
              onClick={() => setEmptyConfirmOpen(true)}
            >
              Empty trash
            </Button>
          </span>
        )}
      </header>

      {entries.length === 0 ? (
        <EmptyState
          icon={<Icon path="mdi-delete-outline" size={2} />}
          title="Trash is empty."
          description="Deleted pages and their subtrees land here; restore brings them back."
        />
      ) : (
        <ul className="nt-trash-hub__rows">
          {entries.map((entry) => {
            const name = deriveDisplayName(entry.node) || "Untitled";
            return (
              <li key={entry.node.id} className="nt-trash-hub__row">
                <span className="nt-trash-hub__icon" aria-hidden="true">
                  <Icon path={nodeIcon(entry.node, client.effectiveClassIcons()) ?? "mdi-file-outline"} size={0.9} />
                </span>
                <span className="nt-trash-hub__name" title={name}>
                  {name}
                </span>
                <span
                  className="nt-trash-hub__stamp"
                  title={new Date(entry.deletedAt).toLocaleString()}
                >
                  {relativeTime(entry.deletedAt)}
                </span>
                <span className="nt-trash-hub__actions">
                  <button
                    type="button"
                    className="nt-trash-hub__action"
                    onClick={() => {
                      void client.restoreObject(entry.node.id).then(() => onOpenNode(entry.node.id));
                    }}
                  >
                    <Icon path="mdi-restore" size={0.85} />
                    Restore
                  </button>
                  <button
                    type="button"
                    className="nt-trash-hub__action nt-trash-hub__action--danger"
                    onClick={() => setPermanentTarget(entry)}
                  >
                    <Icon path="mdi-delete-forever-outline" size={0.85} />
                    Delete permanently
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {permanentTarget !== null && (
        <ConfirmationModal
          isOpen
          variant="danger"
          title="Delete permanently?"
          message={`"${deriveDisplayName(permanentTarget.node) || "Untitled"}" and its subtree will be gone for good — this cannot be undone.`}
          confirmLabel="Delete permanently"
          onConfirm={() => {
            void client.deleteObject(permanentTarget.node.id, { permanent: true });
            setPermanentTarget(null);
          }}
          onCancel={() => setPermanentTarget(null)}
        />
      )}

      {emptyConfirmOpen && (
        <ConfirmationModal
          isOpen
          variant="danger"
          title="Empty trash?"
          message={`All ${entries.length} item${entries.length === 1 ? "" : "s"} in the trash will be permanently deleted — this cannot be undone.`}
          confirmLabel="Empty trash"
          onConfirm={() => {
            void client.emptyTrash();
            setEmptyConfirmOpen(false);
          }}
          onCancel={() => setEmptyConfirmOpen(false)}
        />
      )}
    </div>
  );
}
