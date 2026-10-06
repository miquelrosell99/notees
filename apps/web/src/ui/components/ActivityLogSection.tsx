/**
 * ActivityLogSection — the ActivityLog section, honestly
 * scoped to what the local projection derives (the original per-node op journal had
 * a backend activity table; the current projection has no such table, and the gap
 * note says "Ops exist; projection+UI missing"). What IS derivable locally:
 *
 *  - Recently created — a workspace-wide query (the query compiler's
 *    entire_workspace scope, sorted createdAt desc): every node kind,
 *    blocks included.
 *  - Recently edited — pages and classes whose updatedAt postdates their
 *    creation (a node whose only event is its own creation is not an
 *    edit): the two lists the client can enumerate workspace-wide. Block
 *    edits bump the block's own timestamp, which surfaces on its page
 *    (footer / focused view), not here — the section says so instead of
 *    implying coverage it lacks.
 *
 * Lazy per the normative SCHEMA.md system-sections contract ("a collapsed
 * section executes no query"): the created query runs ONLY while expanded
 * (first expand, then re-derives per notification while expanded); there is
 * no eager count badge — no materialized activity count exists, so like
 * unlinked references the header shows none. Hide-when-empty reads the
 * cheap active-node proxy (pages + classes); a blocks-only-under-trash
 * workspace is the documented approximation's blind spot, deliberately —
 * trashed-context activity is noise, not signal.
 */

import { useEffect, useState } from "react";

import type { QueryAst } from "@notees/query";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { displayNameFromClient } from "../dateDisplay.js";
import "./ActivityLogSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Rows per group — the feed is a summary, not an archive. */
const CREATED_ROW_LIMIT = 20;
const EDITED_ROW_LIMIT = 10;

/** Workspace-wide, newest-created first. */
function buildRecentCreatedAst(): QueryAst {
  return {
    version: 1,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children: [] },
    sort: [{ field: "createdAt", dir: "desc" }],
  };
}

/**
 * Relative stamp (the formatActivityMessage convention): "Just now", "Nm
 * ago", "Nh ago", "Nd ago", then the locale date. Exported for the unit
 * tests; `now` injects the clock.
 */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (iso === null || iso === "") return "";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const diff = now - time;
  if (diff < 0) return "Just now";
  if (diff < 60 * 1000) return "Just now";
  if (diff < 60 * 60 * 1000) {
    const mins = Math.floor(diff / (60 * 1000));
    return `${mins}m ago`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    return `${hours}h ago`;
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    return `${days}d ago`;
  }
  return new Date(time).toLocaleDateString();
}

/** Read-only class chips (the day-sections idiom) on a feed row. */
function RowClassChips({ client, classIds }: { client: AnyClient; classIds: string[] }) {
  const classes = classIds
    .map((classId) => client.getNode(classId))
    .filter((node): node is ClientNode => node !== undefined);
  if (classes.length === 0) return null;
  return (
    <span className="activity-log__chips">
      {classes.map((cls) => (
        <span key={cls.id} className="activity-log__chip">
          {displayNameFromClient(client, cls.id) ?? cls.id}
        </span>
      ))}
    </span>
  );
}

function FeedRow({
  client,
  node,
  stamp,
  onOpenPage,
}: {
  client: AnyClient;
  node: ClientNode;
  stamp: string;
  onOpenPage?: ((nodeId: string) => void) | undefined;
}) {
  return (
    <li className="activity-log__row">
      <button
        type="button"
        className="activity-log__row-name"
        onClick={() => onOpenPage?.(node.id)}
      >
        {displayNameFromClient(client, node.id) ?? node.id}
      </button>
      <RowClassChips client={client} classIds={node.classIds} />
      <span className="activity-log__stamp">{stamp}</span>
    </li>
  );
}

export interface ActivityLogSectionProps {
  client: AnyClient;
  onOpenPage?: ((nodeId: string) => void) | undefined;
}

export function ActivityLogSection({ client, onOpenPage }: ActivityLogSectionProps) {
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  /**
   * The lazy contract: no query exists until the first expand. While
   * expanded, one created-query per notification; a failed/closed query
   * keeps the previous rows (reference material, never a boot gate).
   */
  const [expanded, setExpanded] = useState(false);
  const [createdRows, setCreatedRows] = useState<ClientNode[] | null>(null);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const run = async () => {
      try {
        const result = await Promise.resolve(client.runQueryAst(buildRecentCreatedAst()));
        if (cancelled) return;
        setCreatedRows(
          result.rows
            .slice(0, CREATED_ROW_LIMIT)
            .map((row) => client.getNode(row.id))
            .filter((node): node is ClientNode => node !== undefined),
        );
      } catch {
        // Closed client / failed query: keep the previous rows.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, version, expanded]);

  // Cheap hide-when-empty proxy (no materialized activity count exists):
  // active pages + classes. A blocks-only-under-trash workspace hides the
  // section though its query would find the blocks — deliberate (see the
  // module doc).
  if (client.listPages().length + client.listClasses().length === 0) return null;

  // Edited: the enumerable-with-timestamps read, computed per render while
  // expanded — the same cost class as the other derived reads.
  const editedRows = expanded
    ? [...client.listPages(), ...client.listClasses()]
        .filter(
          (node) =>
            node.updatedAt !== null &&
            node.createdAt !== null &&
            node.updatedAt > node.createdAt,
        )
        .sort(
          (a, b) =>
            (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id),
        )
        .slice(0, EDITED_ROW_LIMIT)
    : [];

  return (
    <NodeViewSection
      title="Activity"
      icon={<Icon path="mdi-history" size={0.9} />}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {createdRows !== null &&
      createdRows.length === 0 &&
      editedRows.length === 0 ? (
        <div className="nt-section-empty">No recent activity.</div>
      ) : (
        <div className="activity-log">
          {createdRows !== null && createdRows.length > 0 && (
            <div className="activity-log__group">
              <h3 className="activity-log__group-title">Recently created</h3>
              <ul className="activity-log__rows">
                {createdRows.map((node) => (
                  <FeedRow
                    key={node.id}
                    client={client}
                    node={node}
                    stamp={relativeTime(node.createdAt)}
                    onOpenPage={onOpenPage}
                  />
                ))}
              </ul>
            </div>
          )}
          {editedRows.length > 0 && (
            <div className="activity-log__group">
              <h3 className="activity-log__group-title">Recently edited</h3>
              <ul className="activity-log__rows">
                {editedRows.map((node) => (
                  <FeedRow
                    key={node.id}
                    client={client}
                    node={node}
                    stamp={relativeTime(node.updatedAt)}
                    onOpenPage={onOpenPage}
                  />
                ))}
              </ul>
              <p className="activity-log__note">
                Edits are shown for pages and classes; a block's edit time surfaces on its page.
              </p>
            </div>
          )}
        </div>
      )}
    </NodeViewSection>
  );
}
