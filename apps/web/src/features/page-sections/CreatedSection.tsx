/**
 * CreatedSection — the "Created" aggregation for date pages: everything
 * created on the day (day pages, #4) or inside the month/year, composing
 * through the CollectionSection skin: the chrome, the resolve-on-mount
 * contract, and the hide-when-empty gate all ride the skin. The section
 * hides while empty (there is no cheaper materialized count, so the one
 * createdAt range query IS the count: it resolves from mount and re-runs
 * per notification — and on a bounds change through `refreshKey` —
 * independent of expansion, and no chrome renders until it lands), a failed
 * query keeps the previous rows (the Section contract), and the date-chain
 * nodes are excluded (their ids are deterministic auto-created chain pages,
 * never "created that day" content). Only main nodes list (blocks are
 * inline scaffolding). Rows default to the cards view mode, outline one
 * click away; the choice is device-local per host page, never an op — the
 * availability gate reads the resolved set through the skin's rows report
 * (the mode switcher rides the body top, the un-hosted idiom). The query
 * rides useSectionData.
 */

import { useCallback, useState } from "react";

import { parseDateNodeId } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { buildCreatedInPeriodAst } from "../calendar/calendarViewUtils.js";
import { Icon } from "../../ui/Icon.js";
import { ViewToolbar, useAvailableViewModes } from "../collection/index.js";
import type { NodeCollectionItem, ViewMode } from "../collection/index.js";
import { CollectionSection } from "../collection/CollectionSection.js";
import { useViewModePreference } from "../../ui/viewPrefs.js";
import "./CreatedSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

const CREATED_VIEW_MODES: ViewMode[] = ["cards", "outline", "pivot", "graph", "gantt", "calendar"];

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
  const runCreatedQuery = useCallback(
    () =>
      Promise.resolve(client.runQueryAst(buildCreatedInPeriodAst(after, before))).then((result) =>
        result.rows
          .map((row) => client.getNode(row.id))
          .filter((node): node is ClientNode => node !== undefined)
          // The deterministic date chain (year/month/day pages) is
          // auto-created scaffolding — never "created that day" content.
          .filter((node) => parseDateNodeId(node.id) === null)
          .sort(
            (a, b) =>
              (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id),
          )
          .map((node) => ({ node })),
      ),
    [client, after, before],
  );
  /**
   * The resolved-rows COPY (the skin owns the resolution; it reports the
   * rows here) — the availability gate reads the created set: the switcher
   * and the persisted-mode sanitize see only the modes the set feeds.
   */
  const [createdItems, setCreatedItems] = useState<NodeCollectionItem[] | null>(null);
  const availableModes = useAvailableViewModes(client, createdItems ?? [], CREATED_VIEW_MODES);
  const [viewMode, setViewMode] = useViewModePreference(
    `createdSection.${pageId}`,
    "cards",
    availableModes,
  );

  return (
    <CollectionSection
      client={client}
      title="Created"
      icon={<Icon path="mdi-plus-circle-outline" size={0.9} />}
      className="nt-section"
      hideWhenEmpty
      hideUntilResolved
      resolveOnMount
      refreshKey={`${after}|${before}`}
      viewMode={viewMode}
      query={runCreatedQuery}
      onRowsChange={setCreatedItems}
      toolbarContent={
        <div className="nt-created-toolbar">
          <ViewToolbar modes={availableModes} value={viewMode} onChange={setViewMode} />
        </div>
      }
      collection={{
        readOnly: true,
        onNodeClick: (id) => onOpenPage?.(id),
      }}
    />
  );
}
