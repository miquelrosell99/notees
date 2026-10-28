/**
 * BlockBacklinks — the block-level backlink gutter (SCHEMA.md "System
 * sections"): a block with backlinks shows a toggle to the right of the block
 * element carrying the materialized link count (node_stats.backlink_count —
 * a stored number, so the badge renders unconditionally and is exempt from
 * the lazy-loading contract). Toggling expands the STANDARD Backlinks system
 * section (../features/page-sections/SystemSections.js — the same chrome the
 * page-level section renders: the collapsible section header, the hosted
 * views/tabs, the filter bar, the sort button) scoped to that block,
 * containered in a card, rendered inline beneath the row. The gutter button
 * is the single outer toggle: the section mounts only while expanded, so a
 * collapsed gutter executes nothing, and the section's own lazy contract
 * (useSectionData — no query while its header is collapsed, a re-derive per
 * client notification while expanded) takes over from there.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { Icon } from "./Icon.js";
import { Badge } from "../components/ui/fleet/Badge.js";
import { Card } from "../components/ui/fleet/Card.js";
import { BacklinksSection } from "../features/page-sections/SystemSections.js";
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
 * The expanded Backlinks system section beneath the block row, containered in
 * a card. Renders only while expanded — a collapsed gutter mounts nothing (so
 * it runs no query); mounted, the section self-gates on the materialized
 * count (the row's own mount gate already guarantees it reads > 0) and owns
 * its lazy useSectionData contract.
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
  if (!expanded) return null;
  return (
    <div className="nt-block-backlink-refs">
      <Card className="nt-block-backlink-card">
        <BacklinksSection client={client} pageId={nodeId} onOpenPage={openNode} />
      </Card>
    </div>
  );
}
