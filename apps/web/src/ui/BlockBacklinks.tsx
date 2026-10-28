/**
 * BlockBacklinks — the block-level backlink gutter (SCHEMA.md "System
 * sections"): a block with backlinks shows a toggle to the right of the block
 * element carrying the materialized link count (node_stats.backlink_count —
 * a stored number, so the badge renders unconditionally and is exempt from
 * the lazy-loading contract). Toggling expands the STANDARD Backlinks system
 * section (../features/page-sections/SystemSections.js — the page section's
 * chrome: the hosted views/tabs, the filter bar, the sort button) scoped to
 * that block, containered in a card, rendered inline beneath the row. The
 * gutter button is the single outer toggle: the section mounts only while
 * expanded, so a collapsed gutter executes nothing, and it renders with its
 * section header hidden ENTIRELY (hideHeader — the gutter toggle owns the
 * surface, and the hosted default tab names the section "Backlinks"). The
 * card rides the FILLED variant so its surface stands apart from the page
 * background, and the section's stack hairline + page-stack insets retire
 * inside it (the card boundary and padding own both — BlockRowDnD.css).
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { Button } from "../components/ui/kit/Button.js";
import { Card } from "../components/ui/kit/Card.js";
import { BacklinksSection } from "../features/page-sections/SystemSections.js";
import { useOutliner } from "./outliner-context.js";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * The right-gutter toggle: the materialized backlink count alone (the
 * chain icon retired — two elements of chrome for one number read noisy).
 * The STANDARD toggle-button approach (the top bar's sidebar toggles), and
 * the button element IS the badge: the count rides the ghost button as its
 * own label — transparent, no border at rest; the `active` fill is the only
 * background. A nested Badge pill doubled the box and overlapped (owner
 * screenshot 2026-10-28) — one element, one chrome.
 */
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
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={label}
      aria-pressed={expanded}
      title={label}
      active={expanded}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {count}
    </Button>
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
      <Card variant="filled" className="nt-block-backlink-card">
        <BacklinksSection client={client} pageId={nodeId} onOpenPage={openNode} hideHeader />
      </Card>
    </div>
  );
}
