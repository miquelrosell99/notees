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
 * before), the bit conditions keep their tri-state picker. The selection
 * controls ride the kit Dropdown register and the text values the kit Input
 * (the boxed field pairing with SelectTrigger — owner 2026-10-16: the raw
 * native selects rendered the browser's chrome, unaligned with the token
 * interface). Every control
 * keeps its label and value semantics, so the QueryBlockView/QueriesHub
 * integrations are unchanged.
 */

import { useMemo, type ReactNode } from "react";

import { QUERY_PLACEHOLDERS } from "@notees/query";

import type { ClassBinding, ClientNode, ClientPropertySchema } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { Button } from "./ui/Button.js";
import { Dropdown } from "./ui/Dropdown.js";
import { Input } from "./ui/Input.js";
import { displayNameForSettings } from "../dateDisplay.js";
import type { QueryBuilderState } from "../queryBuilder.js";
import "./QueryBuilderFields.css";

/** The read surface the pickers need (both client classes satisfy it). */
export interface BuilderFactsClient {
  listClasses(): ClientNode[];
  getClassBindings(classId: string): ClassBinding[];
  /** The schema rows (options / target filters) behind the bound ids. */
  listPropertySchemas(): ClientPropertySchema[];
}

export interface BuilderFacts {
  classes: ClientNode[];
  /** Bound properties across all classes (deduped by schema id), enriched
   * with the schema row's options + target filter (the type-aware value
   * controls, owner 2026-10-16). */
  boundProperties: Array<{
    id: string;
    name: string;
    type: string;
    options: Array<{ id: string; label: string }> | null;
    targetClassFilter: string[] | null;
  }>;
  numericProperties: Array<{ id: string; name: string; type: string }>;
  classNames: Map<string, string>;
  propertyNames: Map<string, string>;
}

/** The picker sources, derived once per client/notify cycle. */
export function useBuilderFacts(client: BuilderFactsClient): BuilderFacts {
  const classes = client.listClasses();
  return useMemo(() => {
    const schemasById = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
    const boundProperties: BuilderFacts["boundProperties"] = [];
    const seenSchemas = new Set<string>();
    for (const cls of classes) {
      for (const binding of client.getClassBindings(cls.id)) {
        if (seenSchemas.has(binding.propertySchemaId)) continue;
        seenSchemas.add(binding.propertySchemaId);
        const schema = schemasById.get(binding.propertySchemaId);
        boundProperties.push({
          id: binding.propertySchemaId,
          name: binding.name,
          type: binding.type,
          options: schema?.options ?? null,
          targetClassFilter: schema?.targetClassFilter ?? binding.targetClassFilter,
        });
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
  const renderBitActive = state.isEmbedded !== "";
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
        <Dropdown
          size="sm"
          ariaLabel="Scope"
          options={[
            { value: "workspace", label: "Entire workspace" },
            ...(rootIsPage ? [{ value: "page", label: "This page" }] : []),
            { value: "pages", label: "Pages only" },
          ]}
          value={state.scope}
          onChange={(value) => {
            if (value !== null) onChange({ scope: value as QueryBuilderState["scope"] });
          }}
        />
      </div>

      {/* The filters section: one card per condition. */}
      <div className="nt-vb__filters">
        {!anyFilterActive && (
          <p className="nt-vb__empty-note">No filters — all nodes will be shown</p>
        )}
        <ConditionCard label="Class" active={classActive} onRemove={() => onChange({ classId: null })}>
          <Dropdown
            size="sm"
            ariaLabel="Class"
            options={[
              { value: "", label: "Any class" },
              ...classes.map((cls) => ({
                value: cls.id,
                label: displayNameForSettings(cls) || cls.id,
              })),
            ]}
            value={state.classId ?? ""}
            onChange={(value) => {
              if (value !== null) onChange({ classId: value || null });
            }}
          />
        </ConditionCard>
        <ConditionCard
          label="Class bit"
          active={classBitActive}
          onRemove={() => onChange({ isClass: "" })}
        >
          <span className="nt-vb__word">is</span>
          <Dropdown
            size="sm"
            ariaLabel="Class bit"
            options={[
              { value: "", label: "Any" },
              { value: "true", label: "A class" },
              { value: "false", label: "Not a class" },
            ]}
            value={state.isClass}
            onChange={(value) => {
              if (value !== null) onChange({ isClass: value as QueryBuilderState["isClass"] });
            }}
          />
        </ConditionCard>
        <ConditionCard
          label="Structural role"
          active={renderBitActive}
          onRemove={() => onChange({ isEmbedded: "" })}
        >
          <span className="nt-vb__word">is</span>
          <Dropdown
            size="sm"
            ariaLabel="Structural role"
            options={[
              { value: "", label: "Any" },
              { value: "true", label: "Block (embedded in body)" },
              { value: "false", label: "Page (standalone)" },
            ]}
            value={state.isEmbedded}
            onChange={(value) => {
              if (value !== null) onChange({ isEmbedded: value as QueryBuilderState["isEmbedded"] });
            }}
          />
        </ConditionCard>
        <ConditionCard
          label="Text contains"
          active={containsActive}
          onRemove={() => onChange({ contains: "" })}
        >
          <span className="nt-vb__word">contains</span>
          <Input
            size="sm"
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
          <Input
            size="sm"
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
          <Input
            size="sm"
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
          <Dropdown
            size="sm"
            ariaLabel="Sort by"
            options={[
              { value: "", label: "None" },
              { value: "name", label: "Name" },
              { value: "createdAt", label: "Created" },
              { value: "isClass", label: "Class bit" },
              { value: "isEmbedded", label: "Structural role" },
            ]}
            value={state.sortField}
            onChange={(value) => {
              if (value !== null) onChange({ sortField: value as QueryBuilderState["sortField"] });
            }}
          />
          {state.sortField !== "" && (
            <Dropdown
              size="sm"
              ariaLabel="Sort direction"
              options={[
                { value: "asc", label: "Ascending" },
                { value: "desc", label: "Descending" },
              ]}
              value={state.sortDir}
              onChange={(value) => {
                if (value !== null) onChange({ sortDir: value as QueryBuilderState["sortDir"] });
              }}
            />
          )}
        </ConditionCard>
        <ConditionCard
          label="Group by"
          active={groupActive}
          onRemove={() => onChange({ groupBy: "", measure: "count" })}
        >
          <Dropdown
            size="sm"
            ariaLabel="Group by"
            options={[
              { value: "", label: "None" },
              { value: "isClass", label: "Class bit" },
              { value: "isEmbedded", label: "Structural role" },
              ...classes.map((cls) => ({
                value: `class:${cls.id}`,
                label: `Class: ${displayNameForSettings(cls) || cls.id}`,
              })),
              ...boundProperties.map((property) => ({
                value: `property:${property.id}`,
                label: `Property: ${property.name}`,
              })),
            ]}
            value={state.groupBy ?? ""}
            onChange={(value) => {
              if (value !== null) onChange({ groupBy: value });
            }}
          />
          <Dropdown
            size="sm"
            ariaLabel="Measure"
            options={[
              { value: "count", label: "Count" },
              { value: "countDistinct", label: "Count distinct" },
              ...numericProperties.map((property) => ({
                value: `sum:${property.id}`,
                label: `Sum of ${property.name}`,
              })),
              ...numericProperties.map((property) => ({
                value: `avg:${property.id}`,
                label: `Average of ${property.name}`,
              })),
            ]}
            value={state.measure ?? "count"}
            onChange={(value) => {
              if (value !== null) onChange({ measure: value });
            }}
          />
        </ConditionCard>
      </div>
    </div>
  );
}
