/**
 * QueryBuilderFields — the shared builder field grid (scope / class / the
 * Revision-11 bits / text-contains / created window / sort / one aggregation
 * dimension+measure), composed identically by QueryBlockView's popover and
 * the FilterBuilderModal. The representable subset lives in
 * queryBuilder.ts; this module is purely presentational.
 *
 * The original ViewBuilder interaction, chrome-only (the AST is the
 * one grammar; nothing here changes what composes): the fields render as the
 * original block list — a scope bar on top, then one card per condition with an
 * uppercase header label and a remove (✕) that clears the row back to its
 * unset default. Setting a control IS the add gesture (the flat-AND subset
 * has exactly these conditions — the original type menu maps onto "the card you fill
 * in"), and a card whose condition is unset reads as a dashed placeholder;
 * when no filter is set at all, the original empty note names the consequence
 * ("No filters — all nodes will be shown"). The operator pickers present
 * in the original style: the fixed operators ride as prose words (contains / after /
 * before), the bit conditions keep their tri-state picker. Every control
 * keeps its label and value semantics, so the QueryBlockView/QueriesHub
 * integrations are unchanged.
 */

import { useMemo, type ReactNode } from "react";

import { QUERY_PLACEHOLDERS } from "@notees/query";

import type { ClassBinding, ClientNode } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { Button } from "./ui/Button.js";
import { displayNameForSettings } from "../dateDisplay.js";
import type { QueryBuilderState } from "../queryBuilder.js";
import "./QueryBuilderFields.css";

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

/**
 * One condition card: the uppercase header label + the remove (✕) that
 * clears the row (visible only while the condition is set — the unset card
 * is the dashed "add me" placeholder).
 */
function ConditionCard({
  label,
  active,
  onRemove,
  children,
}: {
  label: string;
  active: boolean;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`nt-vb__card${active ? "" : " nt-vb__card--unset"}`}>
      <header className="nt-vb__card-head">
        <span className="nt-vb__card-label">{label}</span>
        {active && (
          <Button
            variant="ghost"
            size="xs"
            icon="mdi-close"
            aria-label={`Remove ${label} filter`}
            title={`Remove ${label} filter`}
            onClick={onRemove}
          />
        )}
      </header>
      <div className="nt-vb__card-body">{children}</div>
    </section>
  );
}

export function QueryBuilderFields({ state, onChange, facts, rootIsPage }: QueryBuilderFieldsProps) {
  const { classes, boundProperties, numericProperties } = facts;

  // Active mirrors the compose gate (queryBuilder.ts): a condition composes
  // into the AST exactly when its trimmed value differs from the default.
  const classActive = state.classId !== null && state.classId !== "";
  const classBitActive = state.isClass !== "";
  const renderBitActive = state.presentAsMain !== "";
  const containsActive = state.contains.trim() !== "";
  const createdAfterActive = state.createdAfter.trim() !== "";
  const createdBeforeActive = state.createdBefore.trim() !== "";
  const sortActive = state.sortField !== "";
  const groupActive = (state.groupBy ?? "") !== "" || (state.measure ?? "count") !== "count";
  const anyFilterActive =
    classActive || classBitActive || renderBitActive || containsActive || createdAfterActive || createdBeforeActive;

  return (
    <div className="nt-vb">
      {/* The scope bar: icon + prose + the scope picker. Scope is always
          set (never a removable condition). */}
      <div className="nt-vb__scope">
        <span className="nt-vb__scope-label">
          <Icon path="mdi-filter-variant" size={0.8} />
          Scope
        </span>
        <select
          aria-label="Scope"
          value={state.scope}
          onChange={(event) =>
            onChange({ scope: event.target.value as QueryBuilderState["scope"] })
          }
        >
          <option value="workspace">Entire workspace</option>
          {rootIsPage && <option value="page">This page</option>}
          <option value="pages">Pages only</option>
        </select>
      </div>

      {/* The filters section: one card per condition. */}
      <div className="nt-vb__filters">
        {!anyFilterActive && (
          <p className="nt-vb__empty-note">No filters — all nodes will be shown</p>
        )}
        <ConditionCard label="Class" active={classActive} onRemove={() => onChange({ classId: null })}>
          <select
            aria-label="Class"
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
        </ConditionCard>
        <ConditionCard
          label="Class bit"
          active={classBitActive}
          onRemove={() => onChange({ isClass: "" })}
        >
          <span className="nt-vb__word">is</span>
          <select
            aria-label="Class bit"
            value={state.isClass}
            onChange={(event) =>
              onChange({ isClass: event.target.value as QueryBuilderState["isClass"] })
            }
          >
            <option value="">Any</option>
            <option value="true">A class</option>
            <option value="false">Not a class</option>
          </select>
        </ConditionCard>
        <ConditionCard
          label="Render bit"
          active={renderBitActive}
          onRemove={() => onChange({ presentAsMain: "" })}
        >
          <span className="nt-vb__word">is</span>
          <select
            aria-label="Render bit"
            value={state.presentAsMain}
            onChange={(event) =>
              onChange({ presentAsMain: event.target.value as QueryBuilderState["presentAsMain"] })
            }
          >
            <option value="">Any</option>
            <option value="true">Main children</option>
            <option value="false">Inline body</option>
          </select>
        </ConditionCard>
        <ConditionCard
          label="Text contains"
          active={containsActive}
          onRemove={() => onChange({ contains: "" })}
        >
          <span className="nt-vb__word">contains</span>
          <input
            aria-label="Text contains"
            value={state.contains}
            onChange={(event) => onChange({ contains: event.target.value })}
          />
        </ConditionCard>
        <ConditionCard
          label="Created after"
          active={createdAfterActive}
          onRemove={() => onChange({ createdAfter: "" })}
        >
          <span className="nt-vb__word">after</span>
          <input
            aria-label="Created after"
            list="nt-query-date-placeholders"
            placeholder="{today} or 2026-10-04"
            value={state.createdAfter}
            onChange={(event) => onChange({ createdAfter: event.target.value })}
          />
        </ConditionCard>
        <ConditionCard
          label="Created before"
          active={createdBeforeActive}
          onRemove={() => onChange({ createdBefore: "" })}
        >
          <span className="nt-vb__word">before</span>
          <input
            aria-label="Created before"
            list="nt-query-date-placeholders"
            placeholder="{today} or 2026-10-04"
            value={state.createdBefore}
            onChange={(event) => onChange({ createdBefore: event.target.value })}
          />
        </ConditionCard>
        <datalist id="nt-query-date-placeholders">
          {QUERY_PLACEHOLDERS.map((placeholder) => (
            <option key={placeholder} value={placeholder} />
          ))}
        </datalist>
        <ConditionCard
          label="Sort by"
          active={sortActive}
          onRemove={() => onChange({ sortField: "" })}
        >
          <select
            aria-label="Sort by"
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
          {state.sortField !== "" && (
            <select
              aria-label="Sort direction"
              value={state.sortDir}
              onChange={(event) =>
                onChange({ sortDir: event.target.value as QueryBuilderState["sortDir"] })
              }
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          )}
        </ConditionCard>
        <ConditionCard
          label="Group by"
          active={groupActive}
          onRemove={() => onChange({ groupBy: "", measure: "count" })}
        >
          <select
            aria-label="Group by"
            value={state.groupBy ?? ""}
            onChange={(event) => onChange({ groupBy: event.target.value })}
          >
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
          <select
            aria-label="Measure"
            value={state.measure ?? "count"}
            onChange={(event) => onChange({ measure: event.target.value })}
          >
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
        </ConditionCard>
      </div>
    </div>
  );
}
