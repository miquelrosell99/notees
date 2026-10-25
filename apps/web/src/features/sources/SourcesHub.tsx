/**
 * SourcesHub — the Sources hub behind the sidebar's Sources entry: the
 * Zotero-parity library surface. The shell composes the shared
 * MainContentFrame: the fleet SurfaceTopBar names the surface AND carries the
 * hub toolbar + the panel toggles (the search box, the
 * count, the exports, Add source, and the settings shortcut moved OUT of
 * the middle column into the bar's actions cluster, so the table pane
 * shows only the table; the toggles show/hide the facets and detail
 * panels), the left pane hosts the source-type facets, the middle cell
 * the items table, the right pane the type-aware detail editor.
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
 * the top-bar toolbar's count/exports and the table's rows), and the
 * panel visibility prefs. The panel toggles are DEVICE-LOCAL session
 * state (device state is never an op), persisted per the
 * deviceSettings register.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { AnyClient } from "../../ui/app/clients.js";
import { MainContentFrame } from "../../ui/MainContentFrame.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import { Button } from "../../components/ui/fleet/index.js";
import { useDeviceSetting } from "../settings/deviceSettings.js";
import type { NodeCollectionItem } from "../collection/index.js";
import { exportSubtreeBibliography } from "../export/exportSubtree.js";
import { downloadBlob } from "../modals/download.js";
import { SourcesFacets } from "./SourcesFacets.js";
import { SourcesTable } from "./SourcesTable.js";
import { SourcesDetail } from "./SourcesDetail.js";
import { SourcesToolbar } from "./SourcesToolbar.js";
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
  // it asks whether ANY source exists at all (unfiltered, unsorted).
  useEffect(() => {
    if (client === undefined || rows === null || rows.length > 0) return;
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

  const exportSet = (format: "bib" | "csl-json"): void => {
    if (client === undefined || displayRows === null || displayRows.length === 0) return;
    // Review Focus 5: exactly the CURRENT filtered set — the displayed row
    // ids, no child pages (a source's subtree is not bibliography).
    const exported = exportSubtreeBibliography(
      client,
      displayRows.map((row) => row.id),
      { format, includeChildPages: false },
    );
    downloadBlob(exported.blob, exported.filename);
  };

  const facetsToggleLabel = facetsPanelOpen ? "Hide facets panel" : "Show facets panel";
  const detailToggleLabel = detailPanelOpen ? "Hide details panel" : "Show details panel";

  return (
    <div className="nt-sources-hub">
      <MainContentFrame
        topBar={
          <SurfaceTopBar
            icon="mdi-bookshelf"
            title="Sources"
            actions={
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon="mdi-dock-left"
                  aria-label={facetsToggleLabel}
                  aria-pressed={facetsPanelOpen}
                  title={facetsToggleLabel}
                  active={facetsPanelOpen}
                  onClick={() => setFacetsPanelOpen(!facetsPanelOpen)}
                />
                {client !== undefined && (
                  <SourcesToolbar
                    qInput={qInput}
                    onQInput={setQInput}
                    count={displayRows?.length ?? 0}
                    onExport={exportSet}
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon="mdi-dock-right"
                  aria-label={detailToggleLabel}
                  aria-pressed={detailPanelOpen}
                  title={detailToggleLabel}
                  active={detailPanelOpen}
                  onClick={() => setDetailPanelOpen(!detailPanelOpen)}
                />
              </>
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
          detailPanelOpen ? (
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
      </MainContentFrame>
    </div>
  );
}
