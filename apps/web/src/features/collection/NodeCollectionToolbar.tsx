/**
 * NodeCollectionToolbar — the transient filter layer's chrome: the control row a
 * `filterable` section renders with its collection — at the body top for an
 * un-hosted collection, inline in the hosted tab bar's right-hand cluster
 * (the section header is a single <button> — no interactive control nests
 * inside it). Composed from kit primitives only: CollapsibleSearchField for
 * the quick text facet, the structured panel is the v1 query-builder block UI
 * ported over the query AST (./FilterBlockBuilder.js — condition rows, nested
 * Match ALL/ANY groups, NOT wrappers, the add menu).
 *
 * The toolbar is CONTROLLED: the FilterQuery is component state at the section
 * (one instance per section view/tab, lost on reload — nothing persisted),
 * the hook applies its composed group post-resolution/pre-windowing, and
 * the eager count stays unfiltered — while the query is active the bar names
 * the match against it ("0 of N"), it never hides the section. The live
 * count moved OFF this panel's foot to the hosted tab bar's active-tab
 * badge; the panel's foot row now carries only
 * the caller's extras (the "Save as tab" escape).
 *
 * The quick search COLLAPSES on wide viewports: a ghost magnifier button
 * expands the field in flow (caret lands in the input), the pill's × folds it
 * back — the kit CollapsibleSearchField (../../components/ui/kit/CollapsibleSearchField.js).
 * At narrow widths (≤768px) the fold becomes a magnifier button whose POPUP
 * carries the field (see `narrowSearch` below) — on a phone the anchored
 * overlay keeps the chrome row its seats. In a wrapping chrome row (the
 * hosted tab bar's right cluster) the toolbar renders LAST so its controls
 * join the cluster's single right-justified group, and its structured panel
 * PORTALS into the topbar's full-width slot — a wrapped line beneath the
 * tabs+controls row, spanning the bar side to side (the width-capped cluster
 * never squeezes it), without moving the other controls.
 */

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { AnyClient } from "./index.js";

import { useMediaQuery } from "../../ui/useMediaQuery.js";
import { Badge } from "../../components/ui/kit/Badge.js";
import { Button } from "../../components/ui/kit/Button.js";
import { ButtonWithPanel } from "../../components/ui/kit/ButtonWithPanel.js";
import { CollapsibleSearchField } from "../../components/ui/kit/CollapsibleSearchField.js";
import { SearchField } from "../../components/ui/kit/SearchField.js";
import { FilterBlockBuilder } from "./FilterBlockBuilder.js";
import { useNodeCollectionTopBarPanelHost } from "./NodeCollectionTopBar.js";
import {
  createSectionView,
  useSectionViews,
} from "./sectionViews.js";
import { autoViewName } from "./NodeCollectionTabs.js";
import {
  EMPTY_FILTER_QUERY,
  filterQueryToGroup,
  isFilterInactive,
  type NodeCollectionToolbarConfig,
  type FilterQuery,
} from "./filterQuery.js";
import type { HostedSectionKey } from "@/core/workspace-client/index.js";
import type { QueryAst } from "@notees/query";
import "./NodeCollectionToolbar.css";

/**
 * The "Save as tab" wiring: when the host section
 * knows its hosted-views identity, the structured panel offers one click to
 * persist the pruned draft as a new section view (a new tab refining the
 * section's rows with the query) and select it. `onSaved` is the host's tab
 * select (the tab state lives at the host, lifted through NodeCollection's
 * controlled hostedViews).
 */
export interface FilterViewSaver {
  client: AnyClient;
  nodeId: string;
  sectionKey: HostedSectionKey | "";
  onSaved: (viewId: string) => void;
}

/**
 * The "Apply to tab" wiring: the host names the SELECTED tab and supplies the commit
 * (default tab → the host's default AST store; a custom tab →
 * updateSectionViewAst). The button rides the structured panel's foot while
 * the composed draft is non-empty; a successful commit hands the query to
 * the tab — the transient structured draft clears (the text search stays).
 */
export interface FilterApplyTarget {
  /** The selected tab's label — the button names it. */
  tabLabel: string;
  /** Persists the draft AST as the selected tab's query. False = write failed. */
  onApply: (ast: QueryAst) => Promise<boolean>;
}

export interface NodeCollectionToolbarProps {
  client: AnyClient;
  /** The section's FilterQuery (component state at the section). */
  value: FilterQuery;
  onChange: (query: FilterQuery) => void;
  /** Which facets the bar offers (default: all). */
  config?: NodeCollectionToolbarConfig | undefined;
  /** The filtered row count — null while the section is unresolved. */
  matchCount: number | null;
  /**
   * The UNFILTERED row count the query runs over — null while unresolved.
   */
  totalCount: number | null;
  /**
   * "Save as tab" persistence (optional): set by hosted sections with the
   * hosted-views identity at hand; renders the panel's save button while
   * the composed draft is non-empty.
   */
  viewSaver?: FilterViewSaver | undefined;
  /**
   * "Apply to tab" commit (optional — the query-node section sets it): the
   * structured panel offers one click to persist the draft as the SELECTED
   * tab's query (see FilterApplyTarget).
   */
  applyTarget?: FilterApplyTarget | undefined;
  /**
   * The panel's initial open state (the `/query` slash flow asks the fresh
   * section to open its structured builder); the toggle owns it from there.
   */
  defaultPanelOpen?: boolean | undefined;
  /**
   * "block" (default) renders the bar as its own body-top row; "inline"
   * renders it inside a toolbar row (a ViewToolbar or the hosted tab bar's
   * right cluster) via `display: contents` — the control row joins the
   * cluster's flex line (shrink-wrapped, one tight right-justified group
   * with the other controls) and the structured panel PORTALS into the
   * topbar's full-width slot beneath the row (in-flow, no overlay; in a
   * non-topbar host it renders in place beneath the row). Render the bar
   * LAST in the wrapping cluster so the panel's line lands below the row
   * without moving the cluster's other controls.
   */
  layout?: "block" | "inline" | undefined;
}

export function NodeCollectionToolbar({ client, value, onChange, config, matchCount, totalCount, viewSaver, applyTarget, defaultPanelOpen = false, layout = "block" }: NodeCollectionToolbarProps) {
  const [panelOpen, setPanelOpen] = useState(defaultPanelOpen);
  /**
   * The full-width panel seat: inside a NodeCollectionTopBar the structured
   * panel PORTALS into the bar's own slot (the bar-level wrapped line spans
   * side to side); elsewhere (the hub-cards host) it renders in place. Null
   * on the first render — the host ref lands before paint, so the portal
   * never flashes in the cluster.
   */
  const topBarPanelHost = useNodeCollectionTopBarPanelHost();
  /**
   * The narrow-viewport fold: at ≤768px the permanent
   * search field gives its row space back and becomes a magnifier button
   * whose popup carries the field (the kit ButtonWithPanel — anchored,
   * toggling, Escape/outside dismissal). Wide widths keep the inline field.
   */
  const narrowSearch = useMediaQuery("(width <= 768px)");

  // The "Save as tab" source: the section's existing views name the new
  // one (autoViewName), the shared cache keeps this subscription cheap.
  const { views } = useSectionViews(
    viewSaver !== undefined ? viewSaver.client : null,
    viewSaver?.nodeId ?? "",
    viewSaver?.sectionKey ?? "linked-references",
  );
  /** The composed draft — the save/apply buttons ride only while it survives pruning. */
  const composedGroup =
    viewSaver !== undefined || applyTarget !== undefined ? filterQueryToGroup(value) : null;
  /** The foot-row cluster: only the caller's extras ride the builder's
   *  bottom row now (the "Apply to tab" / "Save as tab" buttons) — the count
   *  moved to the hosted tab bar's active-tab badge. */
  const canSaveAsTab = viewSaver !== undefined && composedGroup !== null;
  const canApplyToTab = applyTarget !== undefined && composedGroup !== null;

  const saveAsTab = async (): Promise<void> => {
    if (viewSaver === undefined || composedGroup === null) return;
    const view = await createSectionView(viewSaver.client, viewSaver.nodeId, viewSaver.sectionKey, {
      name: autoViewName(views),
      queryAst: { version: 1, scope: { type: "entire_workspace" }, root: composedGroup },
    });
    if (view === null) return; // the write failed — the views chrome surfaces it
    viewSaver.onSaved(view.id);
    // The new tab owns the query now — the transient draft clears (the
    // modal's Run behavior).
    onChange(EMPTY_FILTER_QUERY);
    setPanelOpen(false);
  };

  const applyToTab = async (): Promise<void> => {
    if (applyTarget === undefined || composedGroup === null) return;
    const ok = await applyTarget.onApply({
      version: 1,
      scope: { type: "entire_workspace" },
      root: composedGroup,
    });
    if (!ok) return; // the write failed — the views chrome surfaces it
    // The tab owns the structured query now — the draft group clears; the
    // quick-text search stays (it is a transient overlay, not the tab query).
    onChange({ ...value, group: EMPTY_FILTER_QUERY.group });
    setPanelOpen(false);
  };

  const showText = config?.text ?? true;
  const showClass = config?.class ?? true;
  const showProperties = config?.properties ?? true;
  const showDateRange = config?.dateRange ?? true;
  const showPanelToggle = showClass || showProperties || showDateRange;

  const active = !isFilterInactive(value);
  const hasText = (value.text ?? "") !== "";

  return (
    <div className={`nt-node-collection-toolbar${layout === "inline" ? " nt-node-collection-toolbar--inline" : ""}`}>
      <div className="nt-node-collection-toolbar__row">
        {showText && !narrowSearch && (
          <CollapsibleSearchField
            className="nt-node-collection-toolbar__search"
            size="sm"
            aria-label="Filter by text"
            placeholder="Filter…"
            value={value.text ?? ""}
            onChange={(text) => onChange({ ...value, text })}
            onClear={() => onChange({ ...value, text: "" })}
          />
        )}
        {showText && narrowSearch && (
          <ButtonWithPanel
            icon="mdi mdi-magnify"
            variant="ghost"
            size="sm"
            panelPosition="bottom"
            panelAlignment="end"
            panelWidth="min(78vw, 34ch)"
            tooltip="Search rows"
            aria-label="Search rows"
            buttonProps={{ active: hasText }}
          >
            {() => (
              <div className="nt-node-collection-toolbar__search-pop">
                <SearchField
                  className="nt-node-collection-toolbar__search"
                  aria-label="Filter by text"
                  placeholder="Filter…"
                  autoFocus
                  value={value.text ?? ""}
                  onChange={(event) => onChange({ ...value, text: event.target.value })}
                  onClear={() => onChange({ ...value, text: "" })}
                />
              </div>
            )}
          </ButtonWithPanel>
        )}
        {showPanelToggle && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi mdi-filter-variant"
            aria-label="Structured filters"
            title="More filters"
            aria-expanded={panelOpen}
            active={panelOpen || active}
            onClick={() => setPanelOpen((open) => !open)}
          />
        )}
        {active && matchCount !== null && totalCount !== null && (
          <Badge className="nt-node-collection-toolbar__count" size="xs">
            {matchCount} of {totalCount}
          </Badge>
        )}
        {active && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon="mdi mdi-filter-remove-outline"
            aria-label="Clear filter"
            title="Clear filter"
            onClick={() => {
              onChange(EMPTY_FILTER_QUERY);
              setPanelOpen(false);
            }}
          />
        )}
      </div>
      {panelOpen && (
        <Panel
          client={client}
          value={value}
          onChange={onChange}
          config={config}
          panelHost={layout === "inline" ? topBarPanelHost : null}
          footExtra={
            canApplyToTab || canSaveAsTab ? (
              <>
                {canApplyToTab && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon="mdi mdi-check"
                    aria-label={`Apply to ${applyTarget!.tabLabel}`}
                    title={`Set this filter as the ${applyTarget!.tabLabel} tab's query`}
                    onClick={() => void applyToTab()}
                  />
                )}
                {canSaveAsTab && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon="mdi mdi-tab-plus"
                    aria-label="Save as tab"
                    title="Save this filter as a new tab"
                    onClick={() => void saveAsTab()}
                  />
                )}
              </>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

/** The structured panel: the FilterBlockBuilder framed in the bordered
 * region. Inside a NodeCollectionTopBar it portals into the bar's
 * full-width slot (the wrapped line beneath the chrome row); elsewhere it
 * renders in place, a full-width in-flow region beneath the control row —
 * never an overlay. */
function Panel({
  client,
  value,
  onChange,
  config,
  panelHost,
  footExtra,
}: {
  client: AnyClient;
  value: FilterQuery;
  onChange: (query: FilterQuery) => void;
  config: NodeCollectionToolbarConfig | undefined;
  /** The topbar's full-width seat, when one hosts this toolbar. */
  panelHost: HTMLElement | null;
  footExtra: ReactNode;
}) {
  const panel = (
    <div
      className="nt-node-collection-toolbar__panel"
      role="group"
      aria-label="Structured filters"
    >
      <FilterBlockBuilder
        client={client}
        group={value.group}
        config={config}
        onChange={(group) => onChange({ ...value, group })}
        footExtra={footExtra}
      />
    </div>
  );
  return panelHost !== null ? createPortal(panel, panelHost) : panel;
}
