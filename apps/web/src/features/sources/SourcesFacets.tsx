/**
 * SourcesFacets — the Sources hub's left pane: the source-type facet list.
 * One row per roster type with its live count (the enabled types,
 * alphabetical), the archived types collapsed under a "Hidden types"
 * disclosure with an Enable row each — the SAME setArchived seam the
 * gallery and the settings section toggle (two doors, one switch).
 *
 * Live by subscription: the pane recomputes facetCounts on every client
 * notify (the ArchivedHub version-bump idiom) — enabling a hidden type or
 * adding a source updates the facet AND the table in place, no remount
 * loop. Type picking pushes the App-owned URL state (the calendar's
 * onRouteChange seam); without a client the pane renders its honest empty
 * state (the task-1 shell).
 */

import { useEffect, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";
import { Icon } from "../../ui/Icon.js";
import { EmptyState } from "../../components/ui/kit/EmptyState.js";
import { Button } from "../../components/ui/kit/Button.js";
import { Chip } from "../../components/ui/kit/Chip.js";

import { facetCounts, type SourcesQueryState } from "./sourcesQuery.js";

import "./SourcesFacets.css";

export function SourcesFacets({
  client,
  query,
  onQueryChange = undefined,
}: {
  client?: AnyClient | undefined;
  query?: SourcesQueryState | undefined;
  /**
   * The URL seam: a type pick PUSHES history (a real navigation, back
   * undoes the filter). Omitted = URL-less (unit tests).
   */
  onQueryChange?: ((next: SourcesQueryState, mode: "push" | "replace") => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client?.subscribe(() => setVersion((v) => v + 1)), [client]);
  const [hiddenOpen, setHiddenOpen] = useState(false);

  if (client === undefined) {
    return (
      <EmptyState
        icon={<Icon path="mdi-shape-outline" size={2} />}
        title="No source types"
        description="Source types with items in the library appear here, with live counts."
      />
    );
  }

  const facets = facetCounts(client);
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  const enabled = facets.filter((facet) => !facet.archived).sort(byLabel);
  const hidden = facets.filter((facet) => facet.archived).sort(byLabel);
  const activeType = query?.type ?? null;

  const pick = (classKey: string): void => {
    // Toggling the active type clears the filter (back to every type).
    onQueryChange?.({ type: activeType === classKey ? null : classKey, q: query?.q ?? "", sort: query?.sort ?? null }, "push");
  };

  const enable = (classKey: string): void => {
    // Two doors to one switch: the gallery's SAME active-bit write
    // (setArchived = object.update {active}).
    void client.setArchived(SYSTEM_CLASS_UUIDS[classKey as keyof typeof SYSTEM_CLASS_UUIDS], true).catch(
      (error: unknown) => {
        console.warn(`[sources] setArchived (${classKey}) failed:`, error);
      },
    );
  };

  return (
    <div className="sources-facets nt-main-frame__panel-content">
      <div className="sources-facets__list" role="group" aria-label="Source types">
        {enabled.map((facet) => (
          <Chip
            key={facet.classKey}
            active={activeType === facet.classKey}
            onClick={() => pick(facet.classKey)}
            className="sources-facets__chip"
          >
            {facet.label} · {facet.count}
          </Chip>
        ))}
      </div>

      {hidden.length > 0 && (
        <div className="sources-facets__hidden">
          <Button
            variant="ghost"
            size="sm"
            icon={hiddenOpen ? "mdi-chevron-down" : "mdi-chevron-right"}
            onClick={() => setHiddenOpen((open) => !open)}
            aria-expanded={hiddenOpen}
          >
            Hidden types
          </Button>
          {hiddenOpen && (
            <ul className="sources-facets__hidden-list">
              {hidden.map((facet) => (
                <li key={facet.classKey} className="sources-facets__hidden-row">
                  <span className="sources-facets__hidden-label">
                    {facet.label} · {facet.count}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => enable(facet.classKey)}
                    aria-label={`Enable ${facet.label}`}
                  >
                    Enable
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
