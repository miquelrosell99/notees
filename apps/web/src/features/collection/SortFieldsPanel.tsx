/**
 * SortFieldsPanel — the multi-level sort popup (2026-11-25): the active
 * sort levels in PRIORITY ORDER (each with its asc/desc toggle, move
 * up/down, remove) plus the add-field row with a SEARCH BOX filtering the
 * fields by name. One panel serves the outline and cards views (the
 * table's column-keyed SortPanel is the same idiom over its columns).
 * Picking a field appends it as the lowest-priority level, ascending.
 */

import { useMemo, useState } from "react";

import { Icon } from "../../ui/Icon.js";
import { Input } from "../../components/ui/kit/index.js";
import {
  availableSortFields,
  sortFieldKey,
  sortFieldLabel,
  type SortFieldSpec,
} from "./sorting.js";
import type { AnyClient, NodeCollectionItem } from "./types.js";
import "./SortFieldsPanel.css";

export function SortFieldsPanel({
  client,
  items,
  sort,
  onChange,
}: {
  client: AnyClient;
  items: NodeCollectionItem[];
  sort: SortFieldSpec[];
  onChange: (sort: SortFieldSpec[]) => void;
}) {
  const [query, setQuery] = useState("");
  const fields = useMemo(() => availableSortFields(client, items), [client, items]);
  const unused = fields.filter(
    (option) => !sort.some((spec) => sortFieldKey(spec.field) === sortFieldKey(option.field)),
  );
  const needle = query.trim().toLowerCase();
  const filtered =
    needle === "" ? unused : unused.filter((option) => option.label.toLowerCase().includes(needle));
  return (
    <div className="sort-fields-panel">
      <div className="sort-fields-panel__title">Sort by</div>
      {sort.length === 0 && (
        <div className="sort-fields-panel__hint">No sort — the collection's own order.</div>
      )}
      {sort.map((spec, index) => {
        const label = sortFieldLabel(client, spec.field);
        return (
          <div className="sort-fields-panel__row" key={sortFieldKey(spec.field)}>
            <span className="sort-fields-panel__label">{label}</span>
            <button
              type="button"
              className="sort-fields-panel__action"
              aria-label={`${label}: ${spec.direction === "asc" ? "ascending" : "descending"} — toggle`}
              onClick={() =>
                onChange(
                  sort.map((s) =>
                    sortFieldKey(s.field) === sortFieldKey(spec.field)
                      ? { ...s, direction: s.direction === "asc" ? "desc" : "asc" }
                      : s,
                  ),
                )
              }
            >
              {spec.direction === "asc" ? "↑" : "↓"}
            </button>
            <button
              type="button"
              className="sort-fields-panel__action"
              aria-label={`Move ${label} up`}
              disabled={index === 0}
              onClick={() => {
                const next = [...sort];
                [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                onChange(next);
              }}
            >
              ⌃
            </button>
            <button
              type="button"
              className="sort-fields-panel__action"
              aria-label={`Move ${label} down`}
              disabled={index === sort.length - 1}
              onClick={() => {
                const next = [...sort];
                [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                onChange(next);
              }}
            >
              ⌄
            </button>
            <button
              type="button"
              className="sort-fields-panel__action"
              aria-label={`Remove ${label} sort`}
              onClick={() =>
                onChange(sort.filter((s) => sortFieldKey(s.field) !== sortFieldKey(spec.field)))
              }
            >
              <Icon path="mdi-close" size={0.7} />
            </button>
          </div>
        );
      })}
      {unused.length > 0 && (
        <div className="sort-fields-panel__add">
          <div className="sort-fields-panel__search">
            <Input
              placeholder="Search fields…"
              aria-label="Search sort fields"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {filtered.map((option) => (
            <button
              key={sortFieldKey(option.field)}
              type="button"
              className="sort-fields-panel__add-item"
              onClick={() => {
                onChange([...sort, { field: option.field, direction: "asc" }]);
                setQuery("");
              }}
            >
              <Icon path={option.icon} size={0.8} className="sort-fields-panel__add-icon" />+{" "}
              {option.label}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="sort-fields-panel__hint">No matching fields.</div>
          )}
        </div>
      )}
      {sort.length > 0 && (
        <button type="button" className="sort-fields-panel__reset" onClick={() => onChange([])}>
          Reset
        </button>
      )}
    </div>
  );
}
