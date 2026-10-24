/**
 * SourcesHub — the Sources hub behind the sidebar's Sources entry: the
 * Zotero-parity library surface. The shell composes the shared
 * MainContentFrame: the fleet SurfaceTopBar names the surface, the left pane
 * hosts the source-type facets, the middle cell the items table, the right
 * pane the type-aware detail editor.
 *
 * Law 9 — /sources owns its URL AND its tab title from day one: the route
 * registers in the nav table (the sidebar's push lands on /sources, the
 * popstate handler maps it back, the ONE title effect names it
 * "Sources - Notees"), and the `?type=&q=&sort=` query-string state parses
 * and serializes through sourcesQuery.ts. This task ships the shell with
 * the panes' honest empty states; the data layer, table, and detail editor
 * land in the follow-up tasks — the Add-source door is live from the start
 * (the shipped add-source flow answers the empty state's button).
 */

import { MainContentFrame } from "../../ui/MainContentFrame.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import { SourcesFacets } from "./SourcesFacets.js";
import { SourcesTable } from "./SourcesTable.js";
import { SourcesDetail } from "./SourcesDetail.js";
import { parseSourcesQuery } from "./sourcesQuery.js";
import "./SourcesHub.css";

export function SourcesHub() {
  // The URL's query-string state, parsed on render (pure — the popstate
  // seam re-renders the app on back/forward, so no subscription is needed).
  const query = parseSourcesQuery(window.location.search);
  return (
    <div className="nt-sources-hub">
      <MainContentFrame
        topBar={<SurfaceTopBar icon="mdi-bookshelf" title="Sources" />}
        leftPanel={<SourcesFacets />}
        leftLabel="Source types"
        leftPanelWidth="var(--layout-size-7xl)"
        rightPanel={<SourcesDetail />}
        rightLabel="Source details"
        rightPanelWidth="var(--layout-size-9xl)"
      >
        <SourcesTable query={query} />
      </MainContentFrame>
    </div>
  );
}
