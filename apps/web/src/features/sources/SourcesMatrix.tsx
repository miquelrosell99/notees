/**
 * SourcesMatrix — the Sources hub's Literature Matrix mode (research-tier2
 * slice 6): the comparison grid. Picked sources × picked fields — rows are
 * added by REPEATED single-picks through the shared NodeSelector (scoped
 * `class:source`; its single-pick contract is kept — one pick, one row),
 * the picked set rides the hub's URL state (`?mode=matrix&ids=…`, law 9 —
 * deep-linkable, back undoes a pick), columns are picked from the source
 * family's live bound fields (+ rationale properties where present on a
 * row's schemas — the matrixFields pool), and the cells render the shared
 * propertyDisplayText projection.
 *
 * The chrome composes from `components/ui/kit` (the ui-primitives law);
 * the grid is a plain read-only table — the annotation surface is the
 * comparison NODE, not the grid.
 *
 * **New comparison** authors a `comparison`-classed node embedding the
 * picked sources (one embed per source, D3) and opens it. When the
 * research workflow is NOT enabled the comparison class does not exist:
 * the view says so honestly and offers the ONE-CLICK ENABLE (the
 * materializer runs, then the comparison authors) — it never silently
 * authors an unclassed page with embeds (the slice-6 ruling: a comparison
 * without its class loses the chrome, the template binding, and the
 * lint/section vocabulary that make it a comparison).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";
import { Icon } from "../../ui/Icon.js";
import { Button, Checkbox, EmptyState } from "../../components/ui/kit/index.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { downloadBlob } from "../modals/download.js";
import { exportTimestamp } from "../export/exportSubtree.js";
import {
  materializeWorkflow,
  workflowState,
  type WorkflowState,
} from "../workflows/materialize.js";
import {
  matrixCsv,
  matrixFields,
  matrixRows,
  type MatrixField,
  type SourcesQueryState,
} from "./sourcesQuery.js";
import { createComparison } from "./comparison.js";

import "./SourcesMatrix.css";

export function SourcesMatrix({
  client,
  query,
  onQueryChange,
  onOpenNode,
}: {
  client: AnyClient;
  /** The App-owned parsed query state; `ids` is the picked set. */
  query: SourcesQueryState;
  /** The URL seam: a pick/remove PUSHES the picked set (back undoes it). */
  onQueryChange?: ((next: SourcesQueryState, mode: "push" | "replace") => void) | undefined;
  /** The App's page-view open seam (the authored comparison opens). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}) {
  const ids = query.ids;
  // Live by subscription (the facets-pane idiom): an external write —
  // enabling the workflow, valuing a field — re-derives pool and rows.
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  void version;

  const fields = useMemo(() => matrixFields(client, ids), [client, ids, version]);
  const rows = useMemo(() => matrixRows(client, ids), [client, ids, version]);

  // The picked columns — session state (the URL owns the picked SET; the
  // column pick is view state, like the table view's column configurator).
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const pickedFields = useMemo(
    () => fields.filter((field) => picked.has(field.schemaId)),
    [fields, picked],
  );
  const toggleField = (schemaId: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(schemaId)) next.delete(schemaId);
      else next.add(schemaId);
      return next;
    });
  };

  // The row picker — repeated single-picks (the NodeSelector contract kept).
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pushIds = (next: string[]): void => {
    onQueryChange?.({ ...query, mode: "matrix", ids: next }, "push");
  };

  // The comparison author. The workflow-installed probe is ONE anchor read
  // (the D1 ruling — the same probe the Settings tab reads).
  const [busy, setBusy] = useState(false);
  const state: WorkflowState = workflowState(client, "research");
  const handleNewComparison = async (): Promise<void> => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      if (state !== "installed") {
        // The honest not-installed path: enable the workflow (its
        // materializer converges per step, one undo-journal batch), then
        // author the comparison. Never an unclassed page.
        await materializeWorkflow(client, "research", "enabled");
      }
      const id = await createComparison(client, ids);
      onOpenNode?.(id);
    } catch (error) {
      console.warn("[sources] new comparison failed:", error);
    } finally {
      setBusy(false);
    }
  };

  const handleExportCsv = (): void => {
    const csv = matrixCsv(pickedFields, rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `sources-matrix-${exportTimestamp()}.csv`);
  };

  return (
    <div className="nt-sources-hub__table nt-sources-matrix" role="region" aria-label="Literature matrix">
      <div className="nt-sources-matrix__bar">
        <Button
          ref={addButtonRef}
          variant="outline"
          size="sm"
          icon="mdi-plus"
          onClick={() => setPickerOpen(true)}
        >
          Add source
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-file-delimited-outline"
          disabled={rows.length === 0}
          onClick={handleExportCsv}
        >
          Export CSV
        </Button>
        {state === "installed" ? (
          <Button
            variant="primary"
            size="sm"
            icon="mdi-compare"
            disabled={rows.length === 0 || busy}
            onClick={() => void handleNewComparison()}
          >
            New comparison
          </Button>
        ) : (
          <span className="nt-sources-matrix__offer">
            <span className="nt-sources-matrix__offer-text">
              The research workflow isn't enabled — a comparison needs its comparison class.
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={rows.length === 0 || busy}
              onClick={() => void handleNewComparison()}
            >
              {state === "disabled" ? "Re-enable research workflow" : "Enable research workflow"}
            </Button>
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Icon path="mdi-grid" size={2} />}
          title="No sources picked yet"
          description="Add sources above to build the comparison grid — each pick adds one row."
        />
      ) : (
        <>
          {fields.length > 0 && (
            <div className="nt-sources-matrix__fields" role="group" aria-label="Matrix fields">
              {fields.map((field) => (
                <label className="nt-sources-matrix__field" key={field.schemaId}>
                  <Checkbox
                    size="sm"
                    checked={picked.has(field.schemaId)}
                    onChange={() => toggleField(field.schemaId)}
                  />
                  {field.name}
                </label>
              ))}
            </div>
          )}
          {pickedFields.length === 0 && (
            <p className="nt-sources-matrix__hint">Pick fields above to compare them across the sources.</p>
          )}
          <div className="nt-sources-matrix__scroll">
            <table className="nt-sources-matrix__grid">
              <thead>
                <tr>
                  <th scope="col" className="nt-sources-matrix__title-col">Title</th>
                  {pickedFields.map((field) => (
                    <th scope="col" key={field.schemaId}>{field.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="nt-sources-matrix__title-col">
                      <span className="nt-sources-matrix__row-title">{row.title}</span>
                      <Button
                        variant="ghost"
                        size="xs"
                        icon="mdi-close"
                        aria-label={`Remove ${row.title}`}
                        onClick={() => pushIds(ids.filter((id) => id !== row.id))}
                      />
                    </th>
                    {pickedFields.map((field: MatrixField) => (
                      <td key={field.schemaId}>{row.cells[field.schemaId] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {pickerOpen && (
        <NodeSelector
          client={client}
          searchMode="pages"
          classFilters={[SYSTEM_CLASS_UUIDS.source]}
          canAdd={(node) => !ids.includes(node.id)}
          anchorEl={addButtonRef.current}
          onClose={() => setPickerOpen(false)}
          searchPlaceholder="Search sources"
          noCreate
          hint="Pick a source to add it as a matrix row"
          onAdd={(node) => {
            setPickerOpen(false);
            pushIds([...ids, node.id]);
          }}
        />
      )}
    </div>
  );
}
