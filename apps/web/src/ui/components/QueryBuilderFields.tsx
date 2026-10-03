/**
 * QueryBuilderFields — the shared builder field grid (scope / class / the
 * Revision-11 bits / text-contains / created window / sort / one aggregation
 * dimension+measure), composed identically by QueryBlockView's popover and
 * the FilterBuilderModal (§34.31 V2). The representable subset lives in
 * queryBuilder.ts; this module is purely presentational.
 */

import { useMemo } from "react";

import { QUERY_PLACEHOLDERS } from "@notees/query";

import type { ClassBinding, ClientNode } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import type { QueryBuilderState } from "../queryBuilder.js";

/** The read surface the pickers need (both client classes satisfy it). */
export interface BuilderFactsClient {
  listClasses(): ClientNode[];
  getClassBindings(classId: string): ClassBinding[];
}

export interface BuilderFacts {
  classes: ClientNode[];
  /** Bound properties across all classes (deduped by schema id). */
  boundProperties: Array<{ id: string; name: string; type: string }>;
  numericProperties: Array<{ id: string; name: string; type: string }>;
  classNames: Map<string, string>;
  propertyNames: Map<string, string>;
}

/** The picker sources, derived once per client/notify cycle. */
export function useBuilderFacts(client: BuilderFactsClient): BuilderFacts {
  const classes = client.listClasses();
  return useMemo(() => {
    const boundProperties: Array<{ id: string; name: string; type: string }> = [];
    const seenSchemas = new Set<string>();
    for (const cls of classes) {
      for (const binding of client.getClassBindings(cls.id)) {
        if (seenSchemas.has(binding.propertySchemaId)) continue;
        seenSchemas.add(binding.propertySchemaId);
        boundProperties.push({ id: binding.propertySchemaId, name: binding.name, type: binding.type });
      }
    }
    return {
      classes,
      boundProperties,
      numericProperties: boundProperties.filter((property) => property.type === "number"),
      classNames: new Map(classes.map((cls) => [cls.id, displayNameForSettings(cls) || cls.id])),
      propertyNames: new Map(boundProperties.map((property) => [property.id, property.name])),
    };
    // The bindings read follows the client's notify cycle; classes identity
    // is the cheap proxy (listClasses re-runs on every notify).
  }, [client, classes]);
}

export interface QueryBuilderFieldsProps {
  state: QueryBuilderState;
  onChange: (patch: Partial<QueryBuilderState>) => void;
  facts: BuilderFacts;
  /** Whether the "this page" scope is offered (the host has document chrome). */
  rootIsPage: boolean;
}

export function QueryBuilderFields({ state, onChange, facts, rootIsPage }: QueryBuilderFieldsProps) {
  const { classes, boundProperties, numericProperties } = facts;
  return (
    <>
      <label className="nt-query-field">
        <span>Scope</span>
        <select
          value={state.scope}
          onChange={(event) =>
            onChange({ scope: event.target.value as QueryBuilderState["scope"] })
          }
        >
          <option value="workspace">Entire workspace</option>
          {rootIsPage && <option value="page">This page</option>}
          <option value="pages">Pages only</option>
        </select>
      </label>
      <label className="nt-query-field">
        <span>Class</span>
        <select
          value={state.classId ?? ""}
          onChange={(event) => onChange({ classId: event.target.value || null })}
        >
          <option value="">Any class</option>
          {classes.map((cls) => (
            <option key={cls.id} value={cls.id}>
              {displayNameForSettings(cls) || cls.id}
            </option>
          ))}
        </select>
      </label>
      <label className="nt-query-field">
        <span>Class bit</span>
        <select
          value={state.isClass}
          onChange={(event) =>
            onChange({ isClass: event.target.value as QueryBuilderState["isClass"] })
          }
        >
          <option value="">Any</option>
          <option value="true">Class</option>
          <option value="false">Not a class</option>
        </select>
      </label>
      <label className="nt-query-field">
        <span>Render bit</span>
        <select
          value={state.presentAsMain}
          onChange={(event) =>
            onChange({ presentAsMain: event.target.value as QueryBuilderState["presentAsMain"] })
          }
        >
          <option value="">Any</option>
          <option value="true">Main children</option>
          <option value="false">Inline body</option>
        </select>
      </label>
      <label className="nt-query-field">
        <span>Text contains</span>
        <input
          value={state.contains}
          onChange={(event) => onChange({ contains: event.target.value })}
        />
      </label>
      <label className="nt-query-field">
        <span>Created after</span>
        <input
          list="nt-query-date-placeholders"
          placeholder="{today} or 2026-10-04"
          value={state.createdAfter}
          onChange={(event) => onChange({ createdAfter: event.target.value })}
        />
      </label>
      <label className="nt-query-field">
        <span>Created before</span>
        <input
          list="nt-query-date-placeholders"
          placeholder="{today} or 2026-10-04"
          value={state.createdBefore}
          onChange={(event) => onChange({ createdBefore: event.target.value })}
        />
      </label>
      <datalist id="nt-query-date-placeholders">
        {QUERY_PLACEHOLDERS.map((placeholder) => (
          <option key={placeholder} value={placeholder} />
        ))}
      </datalist>
      <label className="nt-query-field">
        <span>Sort by</span>
        <select
          value={state.sortField}
          onChange={(event) =>
            onChange({ sortField: event.target.value as QueryBuilderState["sortField"] })
          }
        >
          <option value="">None</option>
          <option value="name">Name</option>
          <option value="createdAt">Created</option>
          <option value="isClass">Class bit</option>
          <option value="presentAsMain">Render bit</option>
        </select>
      </label>
      {state.sortField !== "" && (
        <label className="nt-query-field">
          <span>Sort direction</span>
          <select
            value={state.sortDir}
            onChange={(event) =>
              onChange({ sortDir: event.target.value as QueryBuilderState["sortDir"] })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
      )}
      <label className="nt-query-field">
        <span>Group by</span>
        <select value={state.groupBy} onChange={(event) => onChange({ groupBy: event.target.value })}>
          <option value="">None</option>
          <option value="isClass">Class bit</option>
          <option value="presentAsMain">Render bit</option>
          {classes.map((cls) => (
            <option key={cls.id} value={`class:${cls.id}`}>
              Class: {displayNameForSettings(cls) || cls.id}
            </option>
          ))}
          {boundProperties.map((property) => (
            <option key={property.id} value={`property:${property.id}`}>
              Property: {property.name}
            </option>
          ))}
        </select>
      </label>
      <label className="nt-query-field">
        <span>Measure</span>
        <select value={state.measure} onChange={(event) => onChange({ measure: event.target.value })}>
          <option value="count">Count</option>
          <option value="countDistinct">Count distinct</option>
          {numericProperties.map((property) => (
            <option key={property.id} value={`sum:${property.id}`}>
              Sum of {property.name}
            </option>
          ))}
          {numericProperties.map((property) => (
            <option key={property.id} value={`avg:${property.id}`}>
              Average of {property.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
