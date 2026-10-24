/**
 * SourcesTable — the Sources hub's middle pane: the sortable, searchable
 * items table (the display projection over the class:source closure — one
 * row per source, the picked facet/search/sort applied). Task 1 ships the
 * pane's honest empty state only — the Add-source door is live from the
 * start (the shipped add-source flow), the table itself lands with the hub's
 * data layer. The region names its active search filter (the URL's ?q=).
 */

import { Icon } from "../../ui/Icon.js";
import { EmptyState } from "../../components/ui/fleet/EmptyState.js";
import { requestAddSource } from "./AddSourceHost.js";
import type { SourcesQueryState } from "./sourcesQuery.js";

export function SourcesTable({ query }: { query: SourcesQueryState }) {
  return (
    <div
      className="nt-sources-hub__table"
      role="region"
      aria-label={query.q !== "" ? `Sources matching “${query.q}”` : "Sources"}
    >
      <EmptyState
        icon={<Icon path="mdi-bookshelf" size={2} />}
        title="No sources yet"
        description="Add your first source — paste a DOI, ISBN, arXiv link or a URL."
        actionLabel="Add source"
        onAction={() => requestAddSource({})}
      />
    </div>
  );
}
