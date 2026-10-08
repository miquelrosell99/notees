/**
 * FilterBar — the transient filter layer's chrome: the body-top control row
 * a `filterable` section renders above its collection (the section header
 * is a single <button> — no interactive control nests inside it, so the bar
 * rides the body top like the skin's toolbar slot). Composed from kit
 * primitives only: SearchField for the quick text facet, the structured
 * panel is the v1 query-builder block UI ported over the query AST
 * (./FilterBlockBuilder.js — condition rows, nested Match ALL/ANY groups,
 * NOT wrappers, the add menu).
 *
 * The bar is CONTROLLED: the FilterQuery is component state at the section
 * (one instance per section view/tab, lost on reload — nothing persisted),
 * the hook applies its composed group post-resolution/pre-windowing, and
 * the eager count stays unfiltered — while the query is active the bar names
 * the match against it ("0 of N"), it never hides the section. The panel's
 * "N of M rows match" line updates live because the filter applies on every
 * change (the v1 ViewBuilder result-preview pattern).
 */

import { useState } from "react";

import type { AnyClient } from "../views/index.js";

import { Button } from "./ui/Button.js";
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
   * renders it inside a toolbar row (ViewToolbar) — the control row joins
   * the row's flex line and the structured panel drops below as a floating
   * overlay anchored to the bar.
   */
  layout?: "block" | "inline" | undefined;
}

export function FilterBar({ client, value, onChange, config, matchCount, totalCount, layout = "block" }: FilterBarProps) {
  const [panelOpen, setPanelOpen] = useState(false);

  const showText = config?.text ?? true;
  const showClass = config?.class ?? true;
  const showProperties = config?.properties ?? true;
  const showDateRange = config?.dateRange ?? true;
  const showPanelToggle = showClass || showProperties || showDateRange;

  const active = !isFilterInactive(value);

  return (
    <div className={`nt-filter-bar${layout === "inline" ? " nt-filter-bar--inline" : ""}`}>
      <div className="nt-filter-bar__row">
        {showText && (
          <SearchField
            className="nt-filter-bar__search"
            aria-label="Filter by text"
            placeholder="Filter…"
            value={value.text ?? ""}
            onChange={(event) => onChange({ ...value, text: event.target.value })}
          />
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
          className={`nt-filter-bar__panel${layout === "inline" ? " nt-filter-bar__panel--floating" : ""}`}
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
