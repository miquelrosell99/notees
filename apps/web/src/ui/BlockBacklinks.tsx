/**
 * BlockBacklinks — the block-level backlink gutter (SCHEMA.md:117 system
 * sections): a block with backlinks shows a toggle to the right of the block
 * element carrying the materialized link count (node_stats.backlink_count —
 * a stored number, so the badge renders unconditionally and is exempt from
 * the lazy-loading contract). Toggling expands the linked-references system
 * query scoped to that block, rendered inline beneath the row; the query runs
 * on first toggle and caches until an invalidating notification, per the
 * section contract (the same discipline as ../Section.js, with the gutter
 * button as the single toggle instead of a section header).
 */

import { useEffect, useRef, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ReferenceEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "./Icon.js";
import { Badge } from "./components/ui/Badge.js";
import { ReferenceList } from "./components/SystemSections.js";
import { useOutliner } from "./outliner-context.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** The right-gutter toggle: link icon + the materialized backlink count. */
export function BlockBacklinkToggle({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = `${count} linked reference${count === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      className={`nt-block-backlink-toggle${expanded ? " nt-block-backlink-toggle--expanded" : ""}`}
      aria-label={label}
      aria-expanded={expanded}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <Icon path="mdi-link-variant" size={0.8} />
      <Badge size="xs">{count}</Badge>
    </button>
  );
}

/**
 * The expanded linked-references list beneath the block row. Mounted whenever
 * the block has backlinks (so results cache across collapse/expand); the
 * query runs only while expanded and re-runs only on an invalidating
 * notification — a collapsed gutter executes nothing.
 */
export function BlockBacklinkPanel({
  nodeId,
  expanded,
  client,
}: {
  nodeId: string;
  expanded: boolean;
  client: AnyClient;
}) {
  const { openNode } = useOutliner();
  const [entries, setEntries] = useState<ReferenceEntry[] | null>(null);
  /** Notification version at which the query last ran; null = never ran. */
  const lastRunAt = useRef<number | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  useEffect(() => {
    if (!expanded) return;
    if (lastRunAt.current === version) return; // cached result is still fresh
    lastRunAt.current = version;
    try {
      setEntries(client.getLinkedReferences(nodeId));
    } catch {
      // Closed client or a failed section query: keep the previous results.
    }
  }, [expanded, version, client, nodeId]);

  if (!expanded) return null;
  return (
    <div className="nt-block-backlink-refs">
      {entries === null ? null : entries.length === 0 ? (
        <div className="nt-section-empty">No linked references.</div>
      ) : (
        <ReferenceList entries={entries} client={client} onOpenPage={openNode} />
      )}
    </div>
  );
}
