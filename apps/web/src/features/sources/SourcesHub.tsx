/**
 * SourcesHub — the Sources hub behind the sidebar's Sources entry: the
 * Zotero-parity library surface. The shell composes the shared
 * MainContentFrame: the fleet SurfaceTopBar names the surface AND carries the
 * hub chrome: the panel toggles are the fleet SidePanelToggle (the linked
 * unit — the side is declared once and the button reads it), split by
 * panel side: the facets (left-panel) toggle rides
 * the LEADING cluster, before the title; the detail (right-panel) toggle
 * rides the `trailing` cluster — after the actions cluster,
 * last in the bar — while the live filtered count renders as a fleet
 * Badge next to the title (the `titleExtra` slot; the retired "N sources"
 * text), and the actions cluster carries the Duplicates mode switch
 * (task 13) beside the search box (the exports/Add-source/settings doors
 * retired — creation rides the global
 * New flow, whose class-pick routing resolves source-family classes into
 * the add-source dialog and the asset class into the upload modal). The
 * left pane hosts the source-type facets, the middle cell the items
 * table (or, in Duplicates mode, the grouped duplicates list), the right
 * pane the type-aware detail editor — rendered ONLY
 * while a selection exists (the toggle AND the selection: no selection,
 * no pane, no "Select a source" empty state).
 *
 * Law 9 — /sources owns its URL AND its tab title: the route registers in
 * the nav table, and the `?type=&q=&sort=` query-string state parses and
 * serializes through sourcesQuery.ts. The query state is App-owned (the
 * calendar's onRouteChange seam): the hub receives it as a prop and the
 * panes' filter gestures push the serialized path through onQueryChange.
 * Without props the hub runs URL-less — parsing the location on render
 * (the unit tests).
 *
 * The hub owns the shell state: the single SELECTION (the table's rows
 * select a source, the detail pane renders it), the library READ (the
 * loaded rows + the live search input + the filtered set — shared between
 * the top-bar badge and the table's rows), and the panel visibility prefs.
 * The panel toggles are DEVICE-LOCAL session state (device
 * state is never an op), persisted per the deviceSettings register.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { AnyClient } from "../../ui/app/clients.js";
import { MainContentFrame } from "../../ui/MainContentFrame.js";
import { SurfaceTopBar } from "../../components/ui/kit/SurfaceTopBar.js";
import { Badge, Button, SidePanelToggle } from "../../components/ui/kit/index.js";
import { useDeviceSetting } from "../settings/deviceSettings.js";
import type { NodeCollectionItem } from "../collection/index.js";
import { SourcesFacets } from "./SourcesFacets.js";
import { SourcesTable } from "./SourcesTable.js";
import { SourcesDetail } from "./SourcesDetail.js";
import { SourcesToolbar } from "./SourcesToolbar.js";
import { SourcesDuplicates } from "./SourcesDuplicates.js";
import {
  parseSourcesQuery,
  rowMatchesQ,
  runSourcesQuery,
  type SourceRow,
  type SourcesQueryState,
} from "./sourcesQuery.js";
import "./SourcesHub.css";

/** The search box → URL debounce (typing must not thrash the history). */
const Q_DEBOUNCE_MS = 200;

export function SourcesHub({
  client,
  query,
  onQueryChange,
  onOpenNode,
}: {
  client?: AnyClient | undefined;
  /** The App-owned parsed query state; omitted = parsed from the location. */
  query?: SourcesQueryState | undefined;
  /** The URL seam: filter/sort gestures push the serialized path. */
  onQueryChange?:
    | ((next: SourcesQueryState, mode: "push" | "replace") => void)
    | undefined;
  /** The App's page-view open seam (the detail pane's Open affordance). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}) {
  const parsed = query ?? parseSourcesQuery(window.location.search);
  // The single selection: the table drives it, the detail renders it.
  // Node id — it survives re-sorts and re-filters.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Enter in the table hands the focus to the detail pane.
  const detailRef = useRef<HTMLDivElement | null>(null);

  // The hub MODE: the items table (the default) or the Duplicates view
  // (task 13 — the toolbar switch in the actions cluster). Session state
  // (like the selection); the type facet + the search box narrow BOTH
  // modes — the duplicates grouping rides the same filtered row set.
  const [viewMode, setViewMode] = useState<"library" | "duplicates">("library");

  // The panel visibility prefs — DEVICE-LOCAL session state (the device-
  // state-never-an-op law), the deviceSettings register (the focusMode /
  // viewMode precedent): toggles in the top bar show/hide the panels, the
  // choice survives reloads on this device only.
  const [facetsPanelOpen, setFacetsPanelOpen] = useDeviceSetting("sourcesPanel.facets", true);
  const [detailPanelOpen, setDetailPanelOpen] = useDeviceSetting("sourcesPanel.detail", true);

  // The library read (shared by the top-bar toolbar and the table).
  const [rows, setRows] = useState<SourceRow[] | null>(null);
  /** True when the WHOLE library is empty (vs the filters hiding everything). */
  const [libraryEmpty, setLibraryEmpty] = useState(false);
  // Live by subscription (the facets-pane idiom): a write elsewhere —
  // adding a source, enabling a hidden type — re-reads the loaded set.
  const [version, setVersion] = useState(0);
  useEffect(() => client?.subscribe(() => setVersion((v) => v + 1)), [client]);

  // The search box is a local, live filter; the URL follows debounced.
  const [qInput, setQInput] = useState(parsed.q);
  useEffect(() => {
    setQInput(parsed.q);
  }, [parsed.q]);
  // Latest-query ref: the debounce effect keys on the typed value only, so
  // an unrelated re-render with a new query object must not reset its timer.
  const queryRef = useRef(parsed);
  queryRef.current = parsed;
  useEffect(() => {
    if (onQueryChange === undefined) return;
    const handle = window.setTimeout(() => {
      if (qInput !== queryRef.current.q) {
        onQueryChange({ ...queryRef.current, q: qInput }, "replace");
      }
    }, Q_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [qInput, onQueryChange]);

  // The loaded set: one class-scoped AST run per picked type; the q narrow
  // is the client-side contract (see sourcesQuery — the linkedAuthors
  // derivation no store condition can express). Fine at library scale.
  // `version` re-runs the read on every client notify (the subscription).
  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    void version;
    void (async () => {
      try {
        const result = await runSourcesQuery(client, { classKey: parsed.type, q: "" }, null);
        if (!cancelled) setRows(result);
      } catch (error) {
        // A late read on a closing store (or a transient mid-write apply)
        // keeps the last rendered rows — never an unhandled rejection.
        if (!cancelled) console.warn("[sources] items-table re-read failed:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, parsed.type, version]);

  // The empty-LIBRARY check runs only when the filtered set reads empty —
  // it asks whether ANY source exists at all (unfiltered, unsorted). When
  // rows APPEAR the latch resets in place — the first add must clear the
  // empty state without a remount (the latch never reset before: the
  // early return kept "No sources yet" rendered until remount).
  useEffect(() => {
    if (client === undefined || rows === null) return;
    if (rows.length > 0) {
      setLibraryEmpty(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const all = await runSourcesQuery(client, {}, null);
        if (!cancelled) setLibraryEmpty(all.length === 0);
      } catch (error) {
        if (!cancelled) console.warn("[sources] library check failed:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, rows]);

  const displayRows = useMemo(() => {
    if (rows === null) return null;
    const q = qInput.trim().toLowerCase();
    return q === "" ? rows : rows.filter((row) => rowMatchesQ(row, q));
  }, [rows, qInput]);

  const items = useMemo<NodeCollectionItem[]>(() => {
    if (client === undefined || displayRows === null) return [];
    return displayRows.flatMap((row) => {
      const node = client.getNode(row.id);
      return node === undefined ? [] : [{ node, meta: { source: row } }];
    });
  }, [client, displayRows]);

  // The toggle chrome (labels, pressed state, dock icon) rides the shared
  // SidePanelToggle — the side is declared once per panel and the button
  // reads it. The right pane renders ONLY with a selection (the toggle AND
  // the selection): the pressed/active chrome reports the EFFECTIVE
  // visibility, not the bare pref. The panes themselves ride MainContentFrame's
  // leftPanel/rightPanel slots (the frame owns the aside landmarks), so the
  // toggle-only export is the link here; the panels render from the same
  // `facetsPanelOpen` / `detailVisible` values below. The Duplicates mode
  // hides the detail pane — the selection is the table's concept.
  const detailVisible =
    viewMode === "library" && detailPanelOpen && selectedId !== null;

  return (
    <div className="nt-sources-hub">
      <MainContentFrame
        topBar={
          <SurfaceTopBar
            className="sources-hub__topbar"
            leading={
              <SidePanelToggle
                side="left"
                open={facetsPanelOpen}
                onToggle={() => setFacetsPanelOpen(!facetsPanelOpen)}
                label="facets panel"
              />
            }
            icon="mdi-bookshelf"
            title="Sources"
            titleExtra={
              <span aria-live="polite" aria-label="Source count">
                <Badge size="sm" variant="neutral">
                  {displayRows?.length ?? 0}
                </Badge>
              </span>
            }
            actions={
              client !== undefined ? (
                <div className="nt-sources-hub__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="mdi-content-duplicate"
                    active={viewMode === "duplicates"}
                    aria-label="Show duplicates"
                    aria-pressed={viewMode === "duplicates"}
                    onClick={() =>
                      setViewMode((mode) => (mode === "duplicates" ? "library" : "duplicates"))
                    }
                  />
                  <SourcesToolbar qInput={qInput} onQInput={setQInput} />
                </div>
              ) : undefined
            }
            trailing={
              <SidePanelToggle
                side="right"
                open={detailVisible}
                labelOpen={detailPanelOpen}
                onToggle={() => setDetailPanelOpen(!detailPanelOpen)}
                label="details panel"
              />
            }
          />
        }
        leftPanel={
          facetsPanelOpen ? (
            <SourcesFacets client={client} query={parsed} onQueryChange={onQueryChange} />
          ) : undefined
        }
        leftLabel="Source types"
        leftPanelWidth="var(--layout-size-7xl)"
        rightPanel={
          detailVisible ? (
            <div ref={detailRef} tabIndex={-1} className="nt-sources-hub__detail-focus">
              <SourcesDetail
                client={client}
                selectedId={selectedId}
                {...(onOpenNode !== undefined ? { onOpenNode } : {})}
                onDeleted={(nodeId) => setSelectedId((current) => (current === nodeId ? null : current))}
              />
            </div>
          ) : undefined
        }
        rightLabel="Source details"
        rightPanelWidth="var(--layout-size-9xl)"
      >
        {viewMode === "duplicates" && client !== undefined ? (
          <SourcesDuplicates
            client={client}
            rows={displayRows}
            loading={rows === null}
          />
        ) : (
          <SourcesTable
            client={client}
            query={parsed}
            onQueryChange={onQueryChange}
            items={items}
            loading={client !== undefined && rows === null}
            libraryEmpty={libraryEmpty}
            q={qInput}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onFocusDetail={() => detailRef.current?.focus()}
          />
        )}
      </MainContentFrame>
    </div>
  );
}
