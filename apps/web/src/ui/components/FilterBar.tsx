/**
 * FilterBar — the transient filter layer's chrome: the control row a
 * `filterable` section renders with its collection — at the body top for an
 * un-hosted collection, inline in the hosted tab bar's right-hand cluster
 * (the section header is a single <button> — no interactive control nests
 * inside it). Composed from kit primitives only: SearchField for the quick
 * text facet, the structured panel is the v1 query-builder block UI ported
 * over the query AST (./FilterBlockBuilder.js — condition rows, nested
 * Match ALL/ANY groups, NOT wrappers, the add menu).
 *
 * The bar is CONTROLLED: the FilterQuery is component state at the section
 * (one instance per section view/tab, lost on reload — nothing persisted),
 * the hook applies its composed group post-resolution/pre-windowing, and
 * the eager count stays unfiltered — while the query is active the bar names
 * the match against it ("0 of N"), it never hides the section. The panel's
 * "N of M rows match" line updates live because the filter applies on every
 * change (the v1 ViewBuilder result-preview pattern).
 *
 * The quick search is a PERMANENT field on wide viewports (owner 2026-10-12,
 * the tab-bar chrome correction — no folding toggle); at narrow widths
 * (≤768px) it folds into a magnifier button whose popup carries the field
 * (see `narrowSearch` below). In a wrapping chrome row (the hosted tab bar's
 * `trailing`) the bar renders LAST in the cluster so its structured panel
 * wraps a full-width line beneath the row WITHOUT moving the other controls.
 */

import { useState } from "react";

import type { AnyClient } from "../views/index.js";

import { useMediaQuery } from "../useMediaQuery.js";
import { Button } from "./ui/Button.js";
import { ButtonWithPanel } from "./ui/ButtonWithPanel.js";
import { SearchField } from "./ui/SearchField.js";
import { FilterBlockBuilder } from "./FilterBlockBuilder.js";
import {
  EMPTY_FILTER_QUERY,
  isFilterInactive,
  type FilterBarConfig,
  type FilterQuery,
} from "./filterQuery.js";
import "./FilterBar.css";

export interface FilterBarProps {
  client: AnyClient;
  /** The section's FilterQuery (component state at the section). */
  value: FilterQuery;
  onChange: (query: FilterQuery) => void;
  /** Which facets the bar offers (default: all). */
  config?: FilterBarConfig | undefined;
  /** The filtered row count — null while the section is unresolved. */
  matchCount: number | null;
  /** The UNFILTERED row count the query runs over — null while unresolved. */
  totalCount: number | null;
  /**
   * "block" (default) renders the bar as its own body-top row; "inline"
   * renders it inside a toolbar row (a ViewToolbar or the hosted tab bar's
   * `trailing`) via `display: contents` — the control row joins the row's
   * flex line and the structured panel takes a full-width wrapped line
   * beneath it (in-flow, no overlay). Render the bar LAST in the wrapping
   * cluster so the panel's wrap lands below the row without moving the
   * cluster's other controls.
   */
  layout?: "block" | "inline" | undefined;
}

export function FilterBar({ client, value, onChange, config, matchCount, totalCount, layout = "block" }: FilterBarProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * The narrow-viewport fold (owner 2026-10-12): at ≤768px the permanent
   * search field gives its row space back and becomes a magnifier button
   * whose popup carries the field (the kit ButtonWithPanel — anchored,
   * toggling, Escape/outside dismissal). Wide widths keep the inline field.
   */
  const narrowSearch = useMediaQuery("(max-width: 768px)");

  const showText = config?.text ?? true;
  const showClass = config?.class ?? true;
  const showProperties = config?.properties ?? true;
  const showDateRange = config?.dateRange ?? true;
  const showPanelToggle = showClass || showProperties || showDateRange;

  const active = !isFilterInactive(value);
  const hasText = (value.text ?? "") !== "";

  return (
    <div className={`nt-filter-bar${layout === "inline" ? " nt-filter-bar--inline" : ""}`}>
      <div className="nt-filter-bar__row">
        {showText && !narrowSearch && (
          <SearchField
            className="nt-filter-bar__search"
            aria-label="Filter by text"
            placeholder="Filter…"
            value={value.text ?? ""}
            onChange={(event) => onChange({ ...value, text: event.target.value })}
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
              <div className="nt-filter-bar__search-pop">
                <SearchField
                  className="nt-filter-bar__search"
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
          <span className="nt-filter-bar__count">
            {matchCount} of {totalCount}
          </span>
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
        <div
          className="nt-filter-bar__panel"
          role="group"
          aria-label="Structured filters"
        >
          {matchCount !== null && totalCount !== null && (
            <p className="nt-filter-bar__result">
              {matchCount} of {totalCount} rows match
            </p>
          )}
          <FilterBlockBuilder
            client={client}
            group={value.group}
            config={config}
            onChange={(group) => onChange({ ...value, group })}
          />
        </div>
      )}
    </div>
  );
}
