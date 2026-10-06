/**
 * CreatedSection — the "Created" aggregation for date pages: everything
 * created on the day (day pages) or inside the month/year
 * (owner 2026-10-06 — month and year pages carry the section too). One
 * createdAt range query per notification (the Section contract: a failed
 * query keeps the previous rows; the section hides while empty), the
 * date-chain nodes excluded (their ids are deterministic auto-created
 * chain pages, never "created that day" content). Rows default to the
 * cards view mode (owner 2026-10-06), outline one click away; the choice is
 * device-local per host page, never an op.
 */

import { useEffect, useState } from "react";

import { parseDateNodeId } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { buildCreatedInPeriodAst } from "./calendarViewUtils.js";
import { Icon } from "../Icon.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { NodeCollection, ViewToolbar } from "../views/index.js";
import type { ViewMode } from "../views/index.js";
import { useViewModePreference } from "../viewPrefs.js";
import "./CreatedSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

const CREATED_VIEW_MODES: ViewMode[] = ["cards", "outline"];

export function CreatedSection({
  client,
  pageId,
  after,
  before,
  onOpenPage,
}: {
  client: AnyClient;
  /** The host date page's id. */
  pageId: string;
  /** UTC ISO-8601 createdAt bounds (createdTodayBounds / createdPeriodBounds). */
  after: string;
  before: string;
  onOpenPage: ((nodeId: string) => void) | undefined;
}) {
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // The count gates hide-when-empty and the rows render on expand; the one
  // structured query re-runs per notification like every other section.
  const [rows, setRows] = useState<ClientNode[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const result = await Promise.resolve(
          client.runQueryAst(buildCreatedInPeriodAst(after, before)),
        );
        if (cancelled) return;
        setRows(
          result.rows
            .map((row) => client.getNode(row.id))
            .filter((node): node is ClientNode => node !== undefined)
            // The deterministic date chain (year/month/day pages) is
            // auto-created scaffolding — never "created that day" content.
            .filter((node) => parseDateNodeId(node.id) === null)
            .sort(
              (a, b) =>
                (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id),
            ),
        );
      } catch {
        // Closed client / failed query: keep the previous rows.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, after, before, version]);

  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useViewModePreference(
    `createdSection.${pageId}`,
    "cards",
    CREATED_VIEW_MODES,
  );

  if (rows === null || rows.length === 0) return null;
  return (
    <NodeViewSection
      title="Created"
      icon={<Icon path="mdi-plus-circle-outline" size={0.9} />}
      count={rows.length}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      <div className="nt-created-toolbar">
        <ViewToolbar modes={CREATED_VIEW_MODES} value={viewMode} onChange={setViewMode} />
      </div>
      <NodeCollection
        viewMode={viewMode}
        client={client}
        items={rows.map((node) => ({ node }))}
        readOnly
        onNodeClick={(id) => onOpenPage?.(id)}
      />
    </NodeViewSection>
  );
}
