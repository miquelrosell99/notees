/**
 * The value-column controls of the filter block builder — the typed
 * per-family pickers the condition row renders after its operator
 * column: the class pill cluster (ClassPillsPick), the family switch
 * (BlockValue) over node targets (single pick / pill cluster / query
 * "matching" word), containers, dates with the relative-period picker, the
 * property family's schema select + typed value control, and the property
 * operator label table. Extracted verbatim from FilterBlockBuilder.tsx
 * (Stage D monolith split).
 */

import { useRef, useState } from "react";

import type { Condition, DatePeriod, PropertyOp, TargetRef } from "@notees/query";

import type { AnyClient } from "./index.js";
import { applyBooleanValue } from "./filterBlockModel.js";
import { Icon } from "../../ui/Icon.js";
import { titleOfNode } from "../../ui/dateDisplay.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { NodePill } from "../metadata/NodePills.js";
import { AddPill } from "../../components/ui/kit/AddPill.js";
import { Dropdown } from "../../components/ui/kit/Dropdown.js";
import { Input } from "../../components/ui/kit/Input.js";
import { type BuilderFacts } from "./builderFacts.js";

const PROPERTY_OP_LABELS: ReadonlyArray<{ op: PropertyOp; label: string }> = [
  { op: "eq", label: "equals" },
  { op: "neq", label: "not equals" },
  { op: "contains", label: "contains" },
  { op: "exists", label: "is set" },
  { op: "gt", label: ">" },
  { op: "gte", label: "≥" },
  { op: "lt", label: "<" },
  { op: "lte", label: "≤" },
];

/**
 * The class pill cluster: the multi-value class
 * pick rides the fleet pill element — effective color/icon resolved the
 * NodePills way, × per pill, the "+ Add class" AddPill opening the anchored
 * NodeSelector in classes mode appending deduped. Broken/unknown ids render
 * an honest plain pill with the raw id. Replaces the old dropdown picks;
 * the single `class` / `classExact` rows bind it to a 0/1-element list with
 * the AddPill hidden while the slot is filled (the "is" register).
 */
function ClassPillsPick({
  ariaLabel,
  classIds,
  single = false,
  client,
  facts,
  onChange,
}: {
  ariaLabel: string;
  classIds: string[];
  /** Single-slot binding (the "is" register): the
   * AddPill hides while a class rides; clear via the pill's × first. */
  single?: boolean;
  client: AnyClient;
  facts: BuilderFacts;
  onChange: (classIds: string[]) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <span className="nt-fb-multipick" aria-label={ariaLabel}>
      {classIds.map((classId) => {
        const cls = facts.classes.find((node) => node.id === classId);
        const label = facts.classNames.get(classId) ?? classId;
        if (cls === undefined) {
          // Broken ref — the raw id, never a silently empty pill.
          return (
            <NodePill
              key={classId}
              color={null}
              icon={null}
              label={label}
              onRemove={() => onChange(classIds.filter((id) => id !== classId))}
              removeLabel={`Remove ${label}`}
            />
          );
        }
        return (
          <NodePill
            key={classId}
            color={client.effectiveClassColor(classId)}
            icon={client.effectiveClassIcon(classId) || null}
            label={label}
            onRemove={() => onChange(classIds.filter((id) => id !== classId))}
            removeLabel={`Remove ${label}`}
          />
        );
      })}
      {!(single && classIds.length >= 1) && (
        <AddPill
          ref={anchorRef}
          label="Add class"
          aria-expanded={open}
          onClick={(element) => {
            anchorRef.current = element;
            setOpen((cur) => !cur);
          }}
        />
      )}
      {open && (
        <NodeSelector
          client={client}
          searchMode="classes"
          anchorEl={anchorRef.current}
          onClose={() => setOpen(false)}
          onAdd={(node) => {
            setOpen(false);
            if (!classIds.includes(node.id)) onChange([...classIds, node.id]);
          }}
        />
      )}
    </span>
  );
}

/**
 * Narrows the member union to its target-carrying view — the op switch
 * form (TS discriminates the multi-literal member ops reliably only through
 * a switch, not if/else chains).
 */
function memberTargetOf(condition: Extract<Condition, { type: "member" }>):
  | { kind: "set" }
  | { kind: "exact"; ids: [string] }
  | { kind: "membership"; target: TargetRef } {
  switch (condition.op) {
    case "exists":
    case "not-exists":
      return { kind: "set" };
    case "exact":
      return { kind: "exact", ids: condition.target.ids };
    default:
      return { kind: "membership", target: condition.target };
  }
}

/** The value column — typed per family, reusing the property-table inputs'
 * shapes (numeric keyboard for number/integer, the placeholder datalist for
 * dates, the anchored node picker for node targets). */
export function BlockValue({
  condition,
  onChange,
  client,
  facts,
  datalistId,
}: {
  condition: Condition;
  onChange: (condition: Condition) => void;
  client: AnyClient;
  facts: BuilderFacts;
  datalistId: string;
}) {
  switch (condition.type) {
    case "member": {
      // The member value column IS the target-mode UI: the anchored node
      // picker / pill cluster for the ids pick, the "matching" word for the
      // nested query (the subgroup itself renders beneath the row), the
      // "this page" badge for the self target. The set bits carry no value.
      const view = memberTargetOf(condition);
      if (view.kind === "set") return null;
      if (view.kind === "exact") {
        // Legacy-wire-only (exact set equality): binds the single-pill
        // cluster to the one carried class id.
        return (
          <ClassPillsPick
            ariaLabel="Class"
            classIds={view.ids}
            single
            client={client}
            facts={facts}
            onChange={(classIds) =>
              onChange({
                ...condition,
                target: { mode: "ids", ids: classIds.slice(0, 1) as [string] },
              } as Condition)
            }
          />
        );
      }
      const target = view.target;
      if (target.mode === "query") {
        return <span className="nt-fb-block__word">matching</span>;
      }
      if (target.mode === "self") {
        return <span className="nt-fb-block__word">this page</span>;
      }
      const setIds = (ids: string[]): void =>
        onChange({ ...condition, target: { mode: "ids", ids } } as Condition);
      switch (condition.family) {
        case "class":
          // The closure membership pick — the multi class pills.
          return (
            <ClassPillsPick
              ariaLabel="Classes"
              classIds={target.ids}
              client={client}
              facts={facts}
              onChange={setIds}
            />
          );
        case "tags":
          return (
            <NodePillsPick
              ariaLabel="Tags"
              nodeIds={target.ids}
              addLabel="Add tag"
              client={client}
              onChange={setIds}
            />
          );
        case "parent":
        case "page":
        case "root":
          // The single-slot register: the containing page / direct parent /
          // root ancestor is ONE node — the AddPill hides while the slot is
          // filled (clear via the pill's × first, no silent replace).
          return (
            <NodePillsPick
              ariaLabel={condition.family === "parent" ? "Parents" : condition.family === "page" ? "Pages" : "Roots"}
              nodeIds={target.ids}
              addLabel={condition.family === "parent" ? "Add parent" : condition.family === "page" ? "Add page" : "Add root"}
              single
              client={client}
              onChange={setIds}
            />
          );
        default: {
          // links / child / childPath / referencePath / parentPath — the
          // multi node pick, per-family accessible labels.
          const labels: Record<string, { aria: string; add: string }> = {
            links: { aria: "Nodes", add: "Add node" },
            child: { aria: "Children", add: "Add child" },
            childPath: { aria: "Targets", add: "Add node" },
            referencePath: { aria: "Targets", add: "Add target" },
            parentPath: { aria: "Ancestors", add: "Add ancestor" },
          };
          const label = labels[condition.family] ?? { aria: "Nodes", add: "Add node" };
          return (
            <NodePillsPick
              ariaLabel={label.aria}
              nodeIds={target.ids}
              addLabel={label.add}
              client={client}
              onChange={setIds}
            />
          );
        }
      }
    }
    case "content":
    case "name":
      return (
        <Input
          size="sm"
          aria-label={condition.type === "name" ? "Title" : "Content"}
          value={condition.value ?? ""}
          onChange={(event) => onChange({ ...condition, value: event.target.value })}
        />
      );
    case "property":
      return <PropertyValue condition={condition} onChange={onChange} facts={facts} client={client} datalistId={datalistId} />;
    case "date": {
      const edited = condition.field === "updated";
      if (condition.op === "between") {
        return (
          <>
            <Input
              size="sm"
              aria-label="From"
              list={datalistId}
              placeholder="from {today}"
              value={condition.from ?? ""}
              onChange={(event) => onChange({ ...condition, from: event.target.value })}
            />
            <Input
              size="sm"
              aria-label="To"
              list={datalistId}
              placeholder="to {today}"
              value={condition.to ?? ""}
              onChange={(event) => onChange({ ...condition, to: event.target.value })}
            />
          </>
        );
      }
      if (condition.op === "within") {
        return (
          <PeriodPick
            ariaLabel="Period"
            value={condition.period ?? "today"}
            onChange={(period) => onChange({ ...condition, period })}
          />
        );
      }
      return (
        <Input
          size="sm"
          aria-label={edited ? "Edited" : "Created"}
          list={datalistId}
          placeholder="{today} or 2026-10-04"
          value={condition.timestamp ?? ""}
          onChange={(event) => onChange({ ...condition, timestamp: event.target.value })}
        />
      );
    }
    case "nodeField": {
      if (condition.field === "isClass") {
        return (
          <Dropdown
            size="sm"
            ariaLabel="Type"
            options={[
              { value: "true", label: "A class" },
              { value: "false", label: "Not a class" },
            ]}
            value={condition.value ?? "true"}
            onChange={(value) => {
              if (value !== null) onChange({ ...condition, value });
            }}
          />
        );
      }
      if (condition.field === "isEmbedded") {
        return (
          <Dropdown
            size="sm"
            ariaLabel="Structural role"
            options={[
              { value: "true", label: "Block (embedded in body)" },
              { value: "false", label: "Page (standalone)" },
            ]}
            value={condition.value ?? "false"}
            onChange={(value) => {
              if (value !== null) onChange({ ...condition, value });
            }}
          />
        );
      }
      // coverAsset / bannerAsset / aliasedNode — the operator IS the condition.
      return null;
    }
  }
}

/** The relative-period picker (is within today / this week / this month / this year). */
const PERIOD_OPTIONS: Array<{ value: DatePeriod; label: string }> = [
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "this_month", label: "This month" },
  { value: "this_year", label: "This year" },
];

function PeriodPick({
  ariaLabel,
  value,
  onChange,
}: {
  ariaLabel: string;
  value: DatePeriod;
  onChange: (period: DatePeriod) => void;
}) {
  return (
    <Dropdown
      size="sm"
      ariaLabel={ariaLabel}
      options={PERIOD_OPTIONS}
      value={value}
      onChange={(next) => {
        if (next !== null) onChange(next);
      }}
    />
  );
}

/**
 * The property family's row-identity slot: the schema
 * dropdown rides the TYPE column so the row reads [Property ▾] [Operator ▾]
 * [Value] — the field → operator → value register (Notion/Odoo). Picking a
 * different property resets the value (it was typed for the old type) and
 * normalizes the condition back to the plain property shape.
 */
export function PropertySchemaPick({
  condition,
  facts,
  onChange,
}: {
  condition: Condition;
  facts: BuilderFacts;
  onChange: (condition: Condition) => void;
}) {
  const schemaId = condition.type === "property" ? condition.schemaId : "";
  return (
    <Dropdown
      size="sm"
      ariaLabel="Property"
      options={[
        { value: "", label: "Pick a property" },
        ...facts.boundProperties.map((property) => ({
          value: property.id,
          label: property.name,
        })),
      ]}
      value={schemaId}
      onChange={(value) => {
        if (value === null) return;
        // A boolean schema seeds the truth value — the register ruling: the
        // value column IS the predicate (is-true ≡ is set + true), so a
        // freshly picked boolean property reads "is true", never a blank
        // half-typed value.
        const schema = facts.boundProperties.find((property) => property.id === value);
        onChange({ type: "property", schemaId: value, op: "eq", value: schema?.type === "boolean" ? true : "" });
      }}
    />
  );
}

/** The property family's value column: schema select + a value control that
 * adapts to the SELECTED schema's type (the Odoo register):
 * select → options dropdown, boolean → true/false, datetime → the date
 * inputs (+ range/period), node-typed → the anchored node picker, number →
 * the numeric keyboard, text → the plain input. The OPERATOR rides the
 * operator column. */
function PropertyValue({
  condition,
  onChange,
  facts,
  client,
  datalistId,
}: {
  condition: Extract<Condition, { type: "property" }>;
  onChange: (condition: Condition) => void;
  facts: BuilderFacts;
  client: AnyClient;
  datalistId: string;
}) {
  const schema = facts.boundProperties.find((property) => property.id === condition.schemaId);
  const numeric = schema !== undefined && (schema.type === "number" || schema.type === "integer");
  const dateLike = schema?.type === "datetime";
  const nodeTyped = schema !== undefined && (schema.type === "object" || (schema.targetClassFilter ?? []).length > 0);
  const patch = (partial: Record<string, unknown>): void =>
    onChange({ ...condition, ...partial } as Condition);
  // The schema picker rides the ROW's type slot (PropertySchemaPick in the
  // BlockRow) — this column is the value control(s) only.
  return (
    <>
      {condition.type === "property" && condition.op !== "exists" && !nodeTyped && schema?.type === "select" && (
        <Dropdown
          size="sm"
          ariaLabel="Value"
          placeholder="Pick an option"
          options={(schema.options ?? []).map((option) => ({
            value: option.id,
            label: option.label,
          }))}
          value={typeof condition.value === "string" ? condition.value : ""}
          onChange={(value) => {
            if (value !== null) patch({ value });
          }}
        />
      )}
      {condition.type === "property" && schema?.type === "boolean" && (
        // The boolean value selector IS the predicate — live on the eq row
        // AND the set bits (picking true/false from an "is set" row
        // re-materializes the eq row: is-true ≡ is set + true).
        <Dropdown
          size="sm"
          ariaLabel="Value"
          options={[
            { value: "true", label: "True" },
            { value: "false", label: "False" },
          ]}
          value={typeof condition.value === "boolean" ? String(condition.value) : ""}
          onChange={(value) => {
            if (value !== null) onChange(applyBooleanValue(condition, value === "true"));
          }}
        />
      )}
      {condition.type === "property" && condition.op !== "exists" && nodeTyped && (
        <NodePickBody
          nodeId={typeof condition.value === "object" && condition.value !== null && "nodeId" in condition.value ? String((condition.value as { nodeId: unknown }).nodeId) : ""}
          placeholder="Pick a node…"
          client={client}
          onPick={(nodeId) => patch({ value: { nodeId } })}
        />
      )}
      {condition.op === "between" && (
        <>
          <Input
            size="sm"
            aria-label="From"
            type={numeric ? "number" : "text"}
            list={dateLike ? datalistId : undefined}
            placeholder={dateLike ? "from {today}" : "from"}
            value={condition.from === undefined || condition.from === null ? "" : String(condition.from)}
            onChange={(event) => patch({ from: numeric ? event.target.value : event.target.value })}
          />
          <Input
            size="sm"
            aria-label="To"
            type={numeric ? "number" : "text"}
            list={dateLike ? datalistId : undefined}
            placeholder={dateLike ? "to {today}" : "to"}
            value={condition.to === undefined || condition.to === null ? "" : String(condition.to)}
            onChange={(event) => patch({ to: event.target.value })}
          />
        </>
      )}
      {condition.op === "within" && (
        <PeriodPick ariaLabel="Period" value={condition.period ?? "today"} onChange={(period) => patch({ period })} />
      )}
      {condition.type === "property" &&
        condition.op !== "exists" &&
        schema?.type !== "select" &&
        schema?.type !== "boolean" &&
        !nodeTyped && (
          <Input
            size="sm"
            aria-label="Value"
            type={numeric ? "number" : "text"}
            list={dateLike ? datalistId : undefined}
            placeholder={dateLike ? "{today} or 2026-10-04" : undefined}
            value={condition.value === undefined || condition.value === null ? "" : String(condition.value)}
            onChange={(event) => patch({ value: event.target.value })}
          />
        )}
    </>
  );
}

/** The node-target picker (static mode) — a quiet trigger naming the chosen
 * node, opening the anchored NodeSelector. */
function NodePickBody({
  nodeId,
  placeholder,
  client,
  onPick,
}: {
  nodeId: string;
  placeholder: string;
  client: AnyClient;
  onPick: (nodeId: string) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const target = nodeId === "" ? undefined : client.getNode(nodeId);
  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className="nt-fb-nodepick"
        aria-label="Pick target node"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="nt-fb-nodepick__label">
          {target !== undefined ? titleOfNode(target) || "Untitled" : placeholder}
        </span>
        <Icon
          path="mdi mdi-chevron-down"
          size={0.7}
          className={`nt-fb-nodepick__chev${open ? " nt-fb-nodepick__chev--open" : ""}`}
        />
      </button>
      {open && (
        <NodeSelector
          client={client}
          anchorEl={anchorRef.current}
          onClose={() => setOpen(false)}
          onAdd={(node) => {
            setOpen(false);
            onPick(node.id);
          }}
        />
      )}
    </>
  );
}

/**
 * The multi node pick: picked nodes ride as the
 * fleet pill cluster — effective color + icon per node, the hover-reveal ×
 * filtering the id out — and the "+ Add" AddPill opens the anchored
 * NodeSelector appending deduped. Node targets are unbounded, so the multi
 * pick is a pill list + search, never a dropdown. Broken refs render an
 * honest plain pill with the raw id. The single-target families (parent /
 * page / root) pass `single`: one slot, the AddPill
 * hidden while filled.
 */
function NodePillsPick({
  ariaLabel,
  nodeIds,
  addLabel,
  single = false,
  client,
  onChange,
}: {
  ariaLabel: string;
  nodeIds: string[];
  addLabel: string;
  /** Single-slot binding: the
   * AddPill hides while a value rides; clear via the pill's × first (no
   * silent replace). The wire list still carries 0/1 elements. */
  single?: boolean;
  client: AnyClient;
  onChange: (nodeIds: string[]) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <span className="nt-fb-multipick" aria-label={ariaLabel}>
      {nodeIds.map((nodeId) => {
        const node = client.getNode(nodeId);
        const label = node !== undefined ? titleOfNode(node) || "Untitled" : nodeId;
        return (
          <NodePill
            key={nodeId}
            color={node !== undefined ? client.effectiveNodeColor(node) : null}
            icon={node?.icon ?? null}
            label={label}
            onRemove={() => onChange(nodeIds.filter((id) => id !== nodeId))}
            removeLabel={`Remove ${label}`}
          />
        );
      })}
      {!(single && nodeIds.length >= 1) && (
        <AddPill
          ref={anchorRef}
          label={addLabel}
          aria-expanded={open}
          onClick={(element) => {
            anchorRef.current = element;
            setOpen((cur) => !cur);
          }}
        />
      )}
      {open && (
        <NodeSelector
          client={client}
          anchorEl={anchorRef.current}
          onClose={() => setOpen(false)}
          onAdd={(node) => {
            setOpen(false);
            if (!nodeIds.includes(node.id)) onChange([...nodeIds, node.id]);
          }}
        />
      )}
    </span>
  );
}
