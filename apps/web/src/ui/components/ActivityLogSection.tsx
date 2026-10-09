/**
 * ActivityLogSection — the Activity section of the page chrome's context
 * column, scoped to the ACTIVE NODE (owner 2026-10-09): the feed answers
 * "what happened to THIS page", never the workspace. What the local
 * projection derives for one node is its own event columns:
 *
 *  - Created — the node's creation stamp.
 *  - Edited — the node's updated stamp, only when it postdates creation
 *    (a node whose only event is its own creation is not an edit).
 *
 * No query exists at all — the two stamps are plain node columns, the same
 * cost class as any derived read, so the normative lazy contract ("a
 * collapsed section executes no query") holds trivially: collapsed renders
 * nothing, expanded reads two columns. Block edits bump the block's own
 * timestamp, which surfaces on its page (the footer / the focused view),
 * not here — the section says so instead of implying coverage it lacks.
 * The earlier workspace-wide feed (the entire-workspace created query + the
 * pages/classes edited lists) is retired: a page's context column is about
 * the page.
 */

import { useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { NodeViewSection } from "./NodeViewSection.js";
import "./ActivityLogSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

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

export interface ActivityLogSectionProps {
  client: AnyClient;
  /** The active node — the feed is scoped to its own events. */
  nodeId: string;
}

export function ActivityLogSection({ client, nodeId }: ActivityLogSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const node = client.getNode(nodeId);
  const edited =
    node !== undefined &&
    node.updatedAt !== null &&
    node.createdAt !== null &&
    node.updatedAt > node.createdAt;

  return (
    <NodeViewSection
      title="Activity"
      icon={<Icon path="mdi-history" size={0.9} />}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {node !== undefined && (
        <div className="activity-log">
          <ul className="activity-log__rows">
            <li className="activity-log__row">
              <span className="activity-log__event">Created</span>
              <span className="activity-log__stamp">{relativeTime(node.createdAt)}</span>
            </li>
            {edited && (
              <li className="activity-log__row">
                <span className="activity-log__event">Edited</span>
                <span className="activity-log__stamp">{relativeTime(node.updatedAt)}</span>
              </li>
            )}
          </ul>
          <p className="activity-log__note">
            This page's own events; a block's edit time surfaces on its page.
          </p>
        </div>
      )}
    </NodeViewSection>
  );
}
