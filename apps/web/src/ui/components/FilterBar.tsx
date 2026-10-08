/**
 * FilterBar — the transient filter layer's chrome: the body-top control row
 * a `filterable` section renders above its collection (the section header
 * is a single <button> — no interactive control nests inside it, so the bar
 * rides the body top like the skin's toolbar slot). Composed from kit
 * primitives only: SearchField for the text facet, plain labeled controls
 * for the structured facets (the query-builder precedent — class picker,
 * created window with the placeholder datalist, property predicate rows)
 * plus kit Button/AddPill chrome.
 *
 * The bar is CONTROLLED: the FilterSpec is component state at the section
 * (one instance per section view/tab, lost on reload — nothing persisted),
 * the hook applies it post-resolution/pre-windowing, and the eager count
 * stays unfiltered — while any facet is active the bar names the match
 * against it ("0 of N"), it never hides the section.
 */

import { useId, useState } from "react";

import { QUERY_PLACEHOLDERS } from "@notees/query";

import type { AnyClient } from "../views/index.js";

import { Button } from "./ui/Button.js";
import { AddPill } from "./ui/AddPill.js";
import { SearchField } from "./ui/SearchField.js";
import { useBuilderFacts } from "./QueryBuilderFields.js";
import {
  EMPTY_FILTER_SPEC,
  type FilterBarConfig,
  type FilterPropertyPredicate,
  type FilterSpec,
} from "./filterSpec.js";
import "./FilterBar.css";

const OP_LABELS: ReadonlyArray<{ op: FilterPropertyPredicate["op"]; label: string }> = [
  { op: "eq", label: "equals" },
  { op: "neq", label: "not equals" },
  { op: "contains", label: "contains" },
  { op: "exists", label: "is set" },
  { op: "gt", label: ">" },
  { op: "gte", label: "≥" },
  { op: "lt", label: "<" },
  { op: "lte", label: "≤" },
];

export interface FilterBarProps {
  client: AnyClient;
  /** The section's FilterSpec (component state at the section). */
  value: FilterSpec;
  onChange: (spec: FilterSpec) => void;
  /** Which facets the bar offers (default: all). */
  config?: FilterBarConfig | undefined;
  /** The filtered row count — null while the section is unresolved. */
  matchCount: number | null;
  /** The UNFILTERED row count the spec runs over — null while unresolved. */
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
  const facts = useBuilderFacts(client);
  const datalistId = useId();
  const [panelOpen, setPanelOpen] = useState(false);

  const showText = config?.text ?? true;
  const showClass = config?.class ?? true;
  const showProperties = config?.properties ?? true;
  const showDateRange = config?.dateRange ?? true;
  const showPanelToggle = showClass || showProperties || showDateRange;

  const text = value.text?.trim() ?? "";
  const predicates = value.propertyPredicates ?? [];
  const after = value.dateRange?.after ?? "";
  const before = value.dateRange?.before ?? "";
  const structuredActive =
    (value.classId ?? "") !== "" || predicates.length > 0 || after.trim() !== "" || before.trim() !== "";
  const active = text !== "" || structuredActive;

  const patch = (partial: Partial<FilterSpec>): void => {
    onChange({ ...value, ...partial });
  };
  const patchDateRange = (partial: Partial<{ after: string; before: string }>): void => {
    patch({ dateRange: { ...value.dateRange, ...partial } });
  };
  const patchPredicate = (index: number, partial: Partial<FilterPropertyPredicate>): void => {
    patch({
      propertyPredicates: predicates.map((predicate, i) =>
        i === index ? { ...predicate, ...partial } : predicate,
      ),
    });
  };

  return (
    <div className={`nt-filter-bar${layout === "inline" ? " nt-filter-bar--inline" : ""}`}>
      <div className="nt-filter-bar__row">
        {showText && (
          <SearchField
            className="nt-filter-bar__search"
            aria-label="Filter by text"
            placeholder="Filter…"
            value={value.text ?? ""}
            onChange={(event) => patch({ text: event.target.value })}
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
            active={panelOpen || structuredActive}
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
              onChange(EMPTY_FILTER_SPEC);
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
          {showClass && (
            <label className="nt-filter-bar__field">
              <span className="nt-filter-bar__label">Class</span>
              <select
                aria-label="Class"
                value={value.classId ?? ""}
                onChange={(event) =>
                  patch({ classId: event.target.value === "" ? undefined : event.target.value })
                }
              >
                <option value="">Any class</option>
                {facts.classes.map((cls) => (
                  <option key={cls.id} value={cls.id}>
                    {facts.classNames.get(cls.id) ?? cls.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {showDateRange && (
            <>
              <label className="nt-filter-bar__field">
                <span className="nt-filter-bar__label">Created after</span>
                <input
                  aria-label="Created after"
                  list={datalistId}
                  placeholder="{today} or 2026-10-04"
                  value={after}
                  onChange={(event) => patchDateRange({ after: event.target.value })}
                />
              </label>
              <label className="nt-filter-bar__field">
                <span className="nt-filter-bar__label">Created before</span>
                <input
                  aria-label="Created before"
                  list={datalistId}
                  placeholder="{today} or 2026-10-04"
                  value={before}
                  onChange={(event) => patchDateRange({ before: event.target.value })}
                />
              </label>
              <datalist id={datalistId}>
                {QUERY_PLACEHOLDERS.map((placeholder) => (
                  <option key={placeholder} value={placeholder} />
                ))}
              </datalist>
            </>
          )}
          {showProperties && facts.boundProperties.length > 0 && (
            <div className="nt-filter-bar__predicates">
              {predicates.map((predicate, index) => (
                <div className="nt-filter-bar__predicate" key={index}>
                  <select
                    aria-label={`Property ${index + 1}`}
                    value={predicate.schemaId}
                    onChange={(event) => patchPredicate(index, { schemaId: event.target.value })}
                  >
                    {facts.boundProperties.map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`Operator ${index + 1}`}
                    value={predicate.op}
                    onChange={(event) =>
                      patchPredicate(index, {
                        op: event.target.value as FilterPropertyPredicate["op"],
                      })
                    }
                  >
                    {OP_LABELS.map(({ op, label }) => (
                      <option key={op} value={op}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {predicate.op !== "exists" && (
                    <input
                      aria-label={`Value ${index + 1}`}
                      value={
                        predicate.value === undefined || predicate.value === null
                          ? ""
                          : String(predicate.value)
                      }
                      onChange={(event) => patchPredicate(index, { value: event.target.value })}
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon="mdi mdi-close"
                    aria-label={`Remove property filter ${index + 1}`}
                    onClick={() =>
                      patch({
                        propertyPredicates: predicates.filter((_, i) => i !== index),
                      })
                    }
                  />
                </div>
              ))}
              <AddPill
                label="Add property filter"
                onClick={() =>
                  patch({
                    propertyPredicates: [
                      ...predicates,
                      {
                        schemaId: facts.boundProperties[0]!.id,
                        op: "eq",
                        value: "",
                      },
                    ],
                  })
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
