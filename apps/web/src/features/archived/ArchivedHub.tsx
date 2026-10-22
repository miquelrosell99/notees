/**
 * ArchivedHub — the Archived hub behind the account popup's Archived entry
 * (owner ruling 2026-10-22, the classes-gallery batch): the archival side
 * of the liveness bit, mirroring the Trash hub's deletion side. Archival
 * is a reversible STATE (object.update {active}) — rows here carry NO
 * trash row; trash has its own hub.
 *
 * Rows are archived nodes (pages, blocks, archived classes), newest first,
 * each with two actions: Unarchive (object.update {active: true} — restore
 * is NOT the unarchive path) and Delete (the routed object.delete — trash
 * for user classes and nodes; reversible, so no confirmation). The hub
 * re-renders on client notifications, so an unarchive lands the row back
 * in the workspace immediately.
 *
 * The view-surface law holds exactly like the Trash hub: the nav register
 * owns the `/archived` URL and the single tab-title effect names it
 * ("Archived - Notees").
 */

import { useEffect, useState } from "react";

import { deriveDisplayName, systemClassNameForId } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ArchivedEntry, WorkspaceClient } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { nodeIcon } from "../../ui/iconFor.js";
import { relativeTime } from "../page-sections/ActivityLogSection.js";
import { EmptyState } from "../../components/ui/fleet/EmptyState.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import "./ArchivedHub.css";

type AnyClient = WorkspaceClient | WorkerClient;

export function ArchivedHub({
  client,
  onOpenNode,
}: {
  client: AnyClient;
  /** Post-unarchive navigation (the unarchive action opens the revived node). */
  onOpenNode: (nodeId: string) => void;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const entries = client.listArchived();

  return (
    <div className="nt-archived-hub">
      {/* The hub chrome rides the shared SurfaceTopBar (owner 2026-10-22),
          pinned above the body; the rows scroll at the card border inside
          the capped content column below. */}
      <SurfaceTopBar icon="mdi-archive-outline" title="Archived" count={entries.length} />

      <div className="nt-archived-hub__body">
        <div className="nt-archived-hub__content">
          {entries.length === 0 ? (
            <EmptyState
              icon={<Icon path="mdi-archive-outline" size={2} />}
              title="Nothing archived."
              description="Archived pages and classes hide from every default read; unarchive brings them back."
            />
          ) : (
            <ul className="nt-archived-hub__rows">
          {entries.map((entry: ArchivedEntry) => {
            const name = deriveDisplayName(entry.node) || "Untitled";
            // System classes have no trash interpretation — the delete
            // routing re-wires their delete to the toggle/archival arms,
            // which add no trash row (the row would sit in this hub
            // unchanged). Only user classes and plain nodes move to trash.
            const canTrash =
              !entry.node.isClass || systemClassNameForId(entry.node.id) === null;
            return (
              <li key={entry.node.id} className="nt-archived-hub__row">
                <span className="nt-archived-hub__icon" aria-hidden="true">
                  <Icon path={nodeIcon(entry.node, client.effectiveClassIcons()) ?? "mdi-file-outline"} size={0.9} />
                </span>
                <span className="nt-archived-hub__name" title={name}>
                  {name}
                </span>
                <span
                  className="nt-archived-hub__stamp"
                  title={new Date(entry.archivedAt).toLocaleString()}
                >
                  {relativeTime(entry.archivedAt)}
                </span>
                <span className="nt-archived-hub__actions">
                  <button
                    type="button"
                    className="nt-archived-hub__action"
                    onClick={() => {
                      void client
                        .updateObject(entry.node.id, { active: true })
                        .then(() => onOpenNode(entry.node.id));
                    }}
                  >
                    <Icon path="mdi-archive-arrow-up-outline" size={0.85} />
                    Unarchive
                  </button>
                  {canTrash && (
                    <button
                      type="button"
                      className="nt-archived-hub__action"
                      title="Moves the item to the trash — restore it from there."
                      onClick={() => void client.deleteObject(entry.node.id)}
                    >
                      <Icon path="mdi-delete-outline" size={0.85} />
                      Delete
                    </button>
                  )}
                </span>
              </li>
            );
          })}
            </ul>
          )}
          {entries.length > 0 && (
            <p className="nt-archived-hub__footer">
              Delete moves an item to the trash — restore it from there.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
