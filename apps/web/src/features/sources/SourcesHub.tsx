/**
 * SourcesHub — the Sources hub behind the sidebar's Sources entry: the
 * Zotero-parity library surface. The shell composes the shared
 * MainContentFrame: the fleet SurfaceTopBar names the surface, the left pane
 * hosts the source-type facets, the middle cell the items table, the right
 * pane the type-aware detail editor.
 *
 * Law 9 — /sources owns its URL AND its tab title: the route registers in
 * the nav table, and the `?type=&q=&sort=` query-string state parses and
 * serializes through sourcesQuery.ts. The query state is App-owned (the
 * calendar's onRouteChange seam): the hub receives it as a prop and the
 * panes' filter gestures push the serialized path through onQueryChange.
 * Without props the hub runs URL-less — parsing the location on render
 * (the unit tests).
 *
 * The hub owns the single SELECTION (task 3): the table's rows (click +
 * arrow keys) select a source, the detail pane renders it, and Enter in
 * the table hands the focus to the detail pane (the existing
 * keyboard-list conventions). The detail body itself lands with the detail
 * task.
 */

import { useRef, useState } from "react";

import type { AnyClient } from "../../ui/app/clients.js";
import { MainContentFrame } from "../../ui/MainContentFrame.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import { SourcesFacets } from "./SourcesFacets.js";
import { SourcesTable } from "./SourcesTable.js";
import { SourcesDetail } from "./SourcesDetail.js";
import { parseSourcesQuery, type SourcesQueryState } from "./sourcesQuery.js";
import "./SourcesHub.css";

export function SourcesHub({
  client,
  query,
  onQueryChange,
}: {
  client?: AnyClient | undefined;
  /** The App-owned parsed query state; omitted = parsed from the location. */
  query?: SourcesQueryState | undefined;
  /** The URL seam: filter/sort gestures push the serialized path. */
  onQueryChange?:
    | ((next: SourcesQueryState, mode: "push" | "replace") => void)
    | undefined;
}) {
  const parsed = query ?? parseSourcesQuery(window.location.search);
  // The single selection (task-3 wiring): the table drives it, the detail
  // renders it. Node id — it survives re-sorts and re-filters.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Enter in the table hands the focus to the detail pane.
  const detailRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className="nt-sources-hub">
      <MainContentFrame
        topBar={<SurfaceTopBar icon="mdi-bookshelf" title="Sources" />}
        leftPanel={<SourcesFacets client={client} query={parsed} onQueryChange={onQueryChange} />}
        leftLabel="Source types"
        leftPanelWidth="var(--layout-size-7xl)"
        rightPanel={
          <div ref={detailRef} tabIndex={-1} className="nt-sources-hub__detail-focus">
            <SourcesDetail client={client} selectedId={selectedId} />
          </div>
        }
        rightLabel="Source details"
        rightPanelWidth="var(--layout-size-9xl)"
      >
        <SourcesTable
          client={client}
          query={parsed}
          onQueryChange={onQueryChange}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onFocusDetail={() => detailRef.current?.focus()}
        />
      </MainContentFrame>
    </div>
  );
}
