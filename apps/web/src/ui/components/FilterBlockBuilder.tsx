/**
 * FilterBlockBuilder — the FilterBar's structured panel: the v1
 * query-builder block UI ported over the v2 query AST (owner 2026-10-08).
 * One feature file pair with FilterBlockBuilder.css (the SectionViewTabs
 * precedent), composed from kit primitives only.
 *
 * The chrome is FLAT, matching the app's list surfaces — no containing
 * cards (owner review 2026-10-08: card-in-card read as a modal; the kit Card
 * lives only on the transient add-menu popover, the one surface elevation
 * is legal): the root group is a bare column (logic toggle + count on one
 * quiet line), nested groups indent under a left hairline, and condition
 * rows are list rows — transparent with a hover fill.
 *
 * The registers are the v1 ones (owner 2026-10-09: the 1:1 block model) —
 * each block is a row of COLUMNS: a TYPE select (Class, Type, Placement,
 * Content, Property, Links, Parent, Cover, Banner, Alias, Created, Edited),
 * an OPERATOR select whose options vary by family (is / is not / contains /
 * is set / is not set / ordering / after / before / full-text — the
 * negatives are not-wrap sugar, the booleans flip their bit), then the VALUE
 * control (typed per family — the property-table register: numeric keyboard,
 * placeholder datalist, anchored node picker). The node-target families
 * (Links, Parent) carry the v1 MODE SWITCH: static (a picked node) or
 * dynamic (a nested query-block list defining the target set — "links to a
 * person node with age > 50"), the nested group rendering beneath the row
 * (the v1 DynamicQuerySection). Groups nest as hairline-indented columns
 * with the Match ALL/ANY header toggle; the root level is not a group.
 * Every control bubbles an immutable update to the root group via onChange —
 * the parent (the FilterBar) owns the state, this module is chrome.
 *
 * The offered condition kinds are the sync-evaluable subset (filterQuery.ts
 * — the linkedTo/fts probe leaves are deliberately not buildable here); the
 * quick-search text is NOT part of this tree — the FilterBar unshifts it
 * into the composed group at prune time.
 */

import type { CSSProperties } from "react";
import { useEffect, useId, useRef, useState } from "react";

import {
  QUERY_PLACEHOLDERS,
  type Child,
  type Condition,
  type ContentOp,
  type Group,
  type Not,
  type PropertyOp,
} from "@notees/query";

import type { AnyClient } from "../views/index.js";

import { Icon } from "../Icon.js";
import { displayNameForSettings } from "../dateDisplay.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { Button } from "./ui/Button.js";
import { ButtonWithPanel } from "./ui/ButtonWithPanel.js";
import { GridMenu } from "./ui/GridMenu.js";
import { SelectionButton, type SelectionButtonOption } from "./ui/SelectionButton.js";
import { useBuilderFacts, type BuilderFacts } from "./QueryBuilderFields.js";
import {
  createCondition,
  filterKindOptionsForConfig,
  FILTER_KIND_OPTIONS,
  type AddMenuEntry,
  type ConditionKind,
  type FilterBarConfig,
} from "./filterQuery.js";
import "./FilterBlockBuilder.css";

const LOGIC_OPTIONS: SelectionButtonOption[] = [
  { value: "and", icon: "mdi mdi-set-all", label: "Match ALL conditions" },
  { value: "or", icon: "mdi mdi-set-center", label: "Match ANY condition" },
];

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

export interface FilterBlockBuilderProps {
  client: AnyClient;
  /** The draft root group (component state at the FilterBar). */
  group: Group;
  onChange: (group: Group) => void;
  /** Which condition kinds the add menu offers (default: all). */
  config?: FilterBarConfig | undefined;
}

export function FilterBlockBuilder({ client, group, onChange, config }: FilterBlockBuilderProps) {
  const facts = useBuilderFacts(client);
  /** The placeholder datalist, rendered once, useId-scoped. */
  const datalistId = useId();
  /**
   * The add menu expands to this width — the builder container's (the
   * owner request: the popup reads as wide as the query builder it feeds).
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuWidth, setMenuWidth] = useState(280);
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const measure = () => setMenuWidth(Math.max(280, el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="nt-fb" ref={rootRef}>
      <datalist id={datalistId}>
        {QUERY_PLACEHOLDERS.map((placeholder) => (
          <option key={placeholder} value={placeholder} />
        ))}
      </datalist>
      <GroupBlock
        group={group}
        onChange={onChange}
        depth={0}
        client={client}
        facts={facts}
        config={config}
        datalistId={datalistId}
        menuWidth={menuWidth}
      />
    </div>
  );
}

// --- the group card ------------------------------------------------------------

interface BlockContext {
  client: AnyClient;
  facts: BuilderFacts;
  config?: FilterBarConfig | undefined;
  datalistId: string;
}

interface GroupBlockProps extends BlockContext {
  group: Group;
  onChange: (group: Group) => void;
  /** The parent's delete — absent at the root. */
  onDelete?: () => void;
  depth: number;
  /** The add menu's width — the builder container's. */
  menuWidth: number;
}

function GroupBlock({ group, onChange, onDelete, depth, client, facts, config, datalistId, menuWidth }: GroupBlockProps) {
  const patch = (partial: Partial<Group>): void => onChange({ ...group, ...partial });
  const updateChild = (index: number, child: Child): void => {
    const children = [...group.children];
    children[index] = child;
    patch({ children });
  };
  const deleteChild = (index: number): void => {
    patch({ children: group.children.filter((_, i) => i !== index) });
  };
  const moveChild = (index: number, delta: -1 | 1): void => {
    const to = index + delta;
    if (to < 0 || to >= group.children.length) return;
    const children = [...group.children];
    [children[index], children[to]] = [children[to]!, children[index]!];
    patch({ children });
  };
  const addEntry = (entry: AddMenuEntry): void => {
    if (entry === "group-and") {
      patch({ children: [...group.children, { type: "group", logic: "and", children: [] }] });
      return;
    }
    if (entry === "group-or") {
      patch({ children: [...group.children, { type: "group", logic: "or", children: [] }] });
      return;
    }
    if (entry === "not") {
      patch({
        children: [
          ...group.children,
          { type: "not", child: { type: "group", logic: "and", children: [] } },
        ],
      });
      return;
    }
    patch({ children: [...group.children, createCondition(entry)] });
  };

  // The root level is NOT a group (owner 2026-10-09) — no count label, no
  // empty placeholder there; those read on nested groups only.
  const nested = depth > 0;
  const menuEntries = filterKindOptionsForConfig(config);
  /** The add menu's open state — drives the trigger chevron (the dropdown register). */
  const [addOpen, setAddOpen] = useState(false);
  const menuItems = menuEntries.map((entry) => ({
    id: entry.value,
    icon: entry.icon,
    label: entry.label,
    description: entry.description,
  }));

  return (
    <div
      className={`nt-fb-group${nested ? " nt-fb-group--nested" : ""}`}
      style={{ "--nt-fb-depth": depth } as CSSProperties}
    >
      <div className="nt-fb-group__header">
        <SelectionButton
          options={LOGIC_OPTIONS}
          value={group.logic}
          onChange={(logic) => patch({ logic: logic as Group["logic"] })}
          size="sm"
          aria-label="Group logic"
        />
        {nested && (
          <>
            <span className="nt-fb-group__count">
              {group.children.length === 0
                ? "Empty group"
                : `${group.children.length} condition${group.children.length === 1 ? "" : "s"}`}
            </span>
            <span className="nt-fb-group__spacer" />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon="mdi mdi-close"
              aria-label="Remove group"
              title="Remove group"
              onClick={onDelete}
            />
          </>
        )}
      </div>
      <div className="nt-fb-group__children">
        {group.children.length === 0 ? (
          nested ? (
            <p className="nt-fb-group__empty">No conditions in this group</p>
          ) : null
        ) : (
          group.children.map((child, index) => {
            if (child.type === "group") {
              return (
                <GroupBlock
                  key={index}
                  group={child}
                  onChange={(updated) => updateChild(index, updated)}
                  onDelete={() => deleteChild(index)}
                  depth={depth + 1}
                  client={client}
                  facts={facts}
                  config={config}
                  datalistId={datalistId}
                  menuWidth={menuWidth}
                />
              );
            }
            if (child.type === "not" && child.child.type === "group") {
              return (
                <NotBlock
                  key={index}
                  not={child}
                  onChange={(updated) => updateChild(index, updated)}
                  onDelete={() => deleteChild(index)}
                  depth={depth + 1}
                  client={client}
                  facts={facts}
                  config={config}
                  datalistId={datalistId}
                  menuWidth={menuWidth}
                />
              );
            }
            return (
              <BlockRow
                key={index}
                child={child}
                onChange={(updated) => updateChild(index, updated)}
                onDelete={() => deleteChild(index)}
                onMoveUp={() => moveChild(index, -1)}
                onMoveDown={() => moveChild(index, 1)}
                index={index}
                totalSiblings={group.children.length}
                depth={depth}
                client={client}
                facts={facts}
                datalistId={datalistId}
              />
            );
          })
        )}
      </div>
      <div className="nt-fb-group__footer">
        {/* The add menu is the ONE group constructor too ("All of"/"Any of"
            insert a group with the mode pre-set) — no separate Add group
            button (owner 2026-10-09). The popup spans the builder container
            (menuWidth) with auto columns filling it. */}
        <ButtonWithPanel
          open={addOpen}
          onOpenChange={setAddOpen}
          customTrigger={
            <>
              Add condition
              <Icon
                path="mdi mdi-chevron-down"
                size={0.7}
                className={`nt-fb-add__chev${addOpen ? " nt-fb-add__chev--open" : ""}`}
              />
            </>
          }
          buttonClassName="nt-fb-add"
          buttonProps={{ size: "sm" }}
          panelPosition="bottom"
          panelAlignment="start"
          panelWidth={menuWidth}
          showCloseButton={false}
          usePortal
          aria-label="Add condition"
        >
          {(closePanel) => (
            <GridMenu
              aria-label="Condition kinds"
              columns="auto"
              items={menuItems}
              onSelect={(id) => {
                addEntry(id as AddMenuEntry);
                closePanel();
              }}
            />
          )}
        </ButtonWithPanel>
      </div>
    </div>
  );
}

// --- the NOT wrapper ------------------------------------------------------------

interface NotBlockProps extends BlockContext {
  not: Not;
  onChange: (not: Not) => void;
  onDelete: () => void;
  depth: number;
  /** The add menu's width — the builder container's. */
  menuWidth: number;
}

function NotBlock({ not, onChange, onDelete, depth, client, facts, config, datalistId, menuWidth }: NotBlockProps) {
  const patch = (child: Condition | Group): void =>
    onChange({ ...not, child: child as Condition | Group });
  return (
    <div className="nt-fb-not" style={{ "--nt-fb-depth": depth } as CSSProperties}>
      <span className="nt-fb-not__badge">NOT</span>
      <div className="nt-fb-not__body">
        {not.child.type === "group" ? (
          <GroupBlock
            group={not.child}
            onChange={patch}
            onDelete={onDelete}
            depth={depth}
            client={client}
            facts={facts}
            config={config}
            datalistId={datalistId}
            menuWidth={menuWidth}
          />
        ) : (
          <BlockRow
            child={{ type: "not", child: not.child }}
            onChange={(child) => {
              const view = blockView(child);
              if (view !== null) patch(view.condition);
            }}
            onDelete={onDelete}
            index={0}
            totalSiblings={1}
            depth={depth}
            client={client}
            facts={facts}
            datalistId={datalistId}
          />
        )}
      </div>
    </div>
  );
}

// --- the block (v1/Odoo register: [type][operator][value][mode]) -----------------

/**
 * A block's view of a child: a single condition, or a NOT wrapping one (the
 * negative operators — "is not", "is not set", "does not contain" — are
 * sugar over a not-wrap, so the draft AST carries them verbatim and the row
 * renders them as an operator choice). NOT-around-a-GROUP stays a group
 * wrapper (the NotBlock), never a block.
 */
function blockView(child: Child): { negated: boolean; condition: Condition } | null {
  if (child.type === "not") {
    return child.child.type === "group"
      ? null
      : { negated: true, condition: child.child };
  }
  if (child.type === "group") return null;
  return { negated: false, condition: child };
}

/** The family a condition belongs to (the block TYPE column's value). */
function familyOf(condition: Condition): ConditionKind {
  switch (condition.type) {
    case "content":
      return "content";
    case "class":
      return "class";
    case "isClass":
      return "type";
    case "presentAsMain":
      return "placement";
    case "property":
      return "property";
    case "linkedTo":
    case "linkedToQuery":
      return "links";
    case "descendantOf":
    case "descendantOfQuery":
      return "parent";
    case "coverAsset":
      return "cover";
    case "bannerAsset":
      return "banner";
    case "aliasedNode":
      return "alias";
    case "createdAfter":
    case "createdBefore":
      return "created";
    case "updatedAfter":
    case "updatedBefore":
      return "edited";
    default:
      return "class";
  }
}

interface OperatorOption {
  value: string;
  label: string;
}

/** The operator column's options per family (the v1 per-type operators). */
function operatorOptions(family: ConditionKind): readonly OperatorOption[] {
  switch (family) {
    case "class":
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
      ];
    case "type":
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
      ];
    case "placement":
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
      ];
    case "content":
      return [
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        { value: "fts", label: "full-text" },
      ];
    case "property":
      return [
        { value: "eq", label: "equals" },
        { value: "neq", label: "not equals" },
        { value: "contains", label: "contains" },
        { value: "exists", label: "is set" },
        { value: "not-exists", label: "is not set" },
        { value: "gt", label: ">" },
        { value: "gte", label: "≥" },
        { value: "lt", label: "<" },
        { value: "lte", label: "≤" },
      ];
    case "links":
    case "parent":
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
      ];
    case "cover":
    case "banner":
    case "alias":
      return [
        { value: "exists", label: "is set" },
        { value: "not-exists", label: "is not set" },
      ];
    case "created":
    case "edited":
      return [
        { value: "after", label: "after" },
        { value: "before", label: "before" },
      ];
  }
}

/** The operator column's current value for a condition (+ its negation). */
function operatorOf(condition: Condition, negated: boolean): string {
  switch (condition.type) {
    case "class":
      return negated ? "is-not" : "is";
    case "isClass":
      return condition.isClass ? "is" : "is-not";
    case "presentAsMain":
      return condition.presentAsMain ? "is" : "is-not";
    case "content":
      if (condition.op === "fts") return "fts";
      return negated ? "not-contains" : "contains";
    case "property":
      if (condition.op === "exists") return negated ? "not-exists" : "exists";
      return condition.op;
    case "linkedTo":
    case "linkedToQuery":
    case "descendantOf":
    case "descendantOfQuery":
      return negated ? "is-not" : "is";
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return negated ? "not-exists" : "exists";
    case "createdAfter":
    case "updatedAfter":
      return "after";
    case "createdBefore":
    case "updatedBefore":
      return "before";
  }
}

/**
 * Apply an operator choice to a block's condition, returning the new child
 * (not-wrapped where the operator is negative). The boolean families flip
 * their bit instead of wrapping; the date families swap their condition
 * type between the after/before arms.
 */
function applyOperator(condition: Condition, op: string): Child {
  const wrap = (next: Condition): Child => next;
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (condition.type) {
    case "class":
      return op === "is-not" ? neg(condition) : wrap(condition);
    case "isClass":
      return { ...condition, isClass: op !== "is-not" };
    case "presentAsMain":
      return { ...condition, presentAsMain: op !== "is-not" };
    case "content":
      if (op === "fts") return { ...condition, op: "fts" };
      return op === "not-contains" ? neg({ ...condition, op: "contains" }) : wrap({ ...condition, op: "contains" });
    case "property":
      if (op === "exists") return wrap({ ...condition, op: "exists", value: undefined });
      if (op === "not-exists") return neg({ type: "property", schemaId: condition.schemaId, op: "exists" });
      return wrap({ ...condition, op: op as PropertyOp, ...(condition.value === undefined ? { value: "" } : {}) });
    case "linkedTo":
    case "linkedToQuery":
    case "descendantOf":
    case "descendantOfQuery":
      return op === "is-not" ? neg(condition) : wrap(condition);
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return op === "not-exists" ? neg(condition) : wrap(condition);
    case "createdAfter":
    case "createdBefore":
      return op === "before"
        ? { type: "createdBefore", timestamp: condition.timestamp }
        : { type: "createdAfter", timestamp: condition.timestamp };
    case "updatedAfter":
    case "updatedBefore":
      return op === "before"
        ? { type: "updatedBefore", timestamp: condition.timestamp }
        : { type: "updatedAfter", timestamp: condition.timestamp };
  }
}

const FAMILY_OPTIONS: readonly { value: ConditionKind; label: string }[] = FILTER_KIND_OPTIONS.filter(
  (option): option is { value: ConditionKind; label: string; icon: string; description: string } =>
    option.value !== "group-and" && option.value !== "group-or" && option.value !== "not",
);

const FAMILY_LABELS: Record<ConditionKind, string> = Object.fromEntries(
  FAMILY_OPTIONS.map((option) => [option.value, option.label]),
) as Record<ConditionKind, string>;

interface BlockRowProps extends BlockContext {
  child: Child;
  onChange: (child: Child) => void;
  onDelete: () => void;
  /** The reorder chevrons — absent at the ends (and for a NOT's single child). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  index: number;
  totalSiblings: number;
  depth: number;
}

function BlockRow({
  child,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  index,
  totalSiblings,
  depth,
  client,
  facts,
  datalistId,
}: BlockRowProps) {
  const view = blockView(child)!;
  const { negated, condition } = view;
  const family = familyOf(condition);
  const label = FAMILY_LABELS[family];
  const canMoveUp = onMoveUp !== undefined && index > 0;
  const canMoveDown = onMoveDown !== undefined && index < totalSiblings - 1;
  const showReorder = onMoveUp !== undefined || onMoveDown !== undefined;
  /** The node-target families: static (picked node) or dynamic (nested query). */
  const dynamic =
    condition.type === "linkedToQuery" || condition.type === "descendantOfQuery";
  return (
    <div className="nt-fb-block">
      <div className="nt-fb-block__row">
        {/* The TYPE column — morphing the block replaces the condition,
            keeping the negation where one was set. */}
        <select
          aria-label="Block type"
          className="nt-fb-block__type"
          value={family}
          onChange={(event) => {
            const next = createCondition(event.target.value as ConditionKind);
            onChange(negated ? { type: "not", child: next } : next);
          }}
        >
          {FAMILY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Operator"
          className="nt-fb-block__operator"
          value={operatorOf(condition, negated)}
          onChange={(event) => onChange(applyOperator(condition, event.target.value))}
        >
          {operatorOptions(family).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <BlockValue
          condition={condition}
          onChange={(next) => onChange(negated ? { type: "not", child: next } : next)}
          client={client}
          facts={facts}
          datalistId={datalistId}
        />
        {(family === "links" || family === "parent") && (
          <SelectionButton
            size="sm"
            aria-label="Target mode"
            options={[
              { value: "static", icon: "mdi mdi-pin-outline", label: "Static — a picked node" },
              { value: "dynamic", icon: "mdi mdi-filter-variant", label: "Dynamic — a nested query" },
            ]}
            value={dynamic ? "dynamic" : "static"}
            onChange={(mode) => {
              const next: Condition =
                mode === "dynamic"
                  ? family === "links"
                    ? { type: "linkedToQuery", root: { type: "group", logic: "and", children: [] } }
                    : { type: "descendantOfQuery", root: { type: "group", logic: "and", children: [] } }
                  : family === "links"
                    ? { type: "linkedTo", nodeId: "" }
                    : { type: "descendantOf", nodeId: "" };
              onChange(negated ? { type: "not", child: next } : next);
            }}
          />
        )}
        <span className="nt-fb-condition__spacer" />
        {showReorder && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon="mdi mdi-chevron-up"
              aria-label="Move up"
              title="Move up"
              disabled={!canMoveUp}
              onClick={onMoveUp}
            />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon="mdi mdi-chevron-down"
              aria-label="Move down"
              title="Move down"
              disabled={!canMoveDown}
              onClick={onMoveDown}
            />
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          icon="mdi mdi-close"
          aria-label={`Remove ${label} condition`}
          title="Remove condition"
          onClick={onDelete}
        />
      </div>
      {/* Dynamic mode: the nested query rides beneath the row (the v1
          DynamicQuerySection register). */}
      {dynamic && (
        <div className="nt-fb-block__nested">
          <GroupBlock
            group={condition.root}
            onChange={(root) =>
              onChange(
                negated
                  ? { type: "not", child: { ...condition, root } }
                  : { ...condition, root },
              )
            }
            depth={depth + 1}
            client={client}
            facts={facts}
            datalistId={datalistId}
            menuWidth={0}
          />
        </div>
      )}
    </div>
  );
}

/** The value column — typed per family, reusing the property-table inputs'
 * shapes (numeric keyboard for number/integer, the placeholder datalist for
 * dates, the anchored node picker for node targets). */
function BlockValue({
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
    case "class":
      return (
        <select
          aria-label="Class"
          value={condition.classId}
          onChange={(event) => onChange({ ...condition, classId: event.target.value })}
        >
          <option value="">Pick a class</option>
          {facts.classes.map((cls) => (
            <option key={cls.id} value={cls.id}>
              {facts.classNames.get(cls.id) ?? cls.id}
            </option>
          ))}
        </select>
      );
    case "isClass":
      return (
        <select
          aria-label="Type"
          value={String(condition.isClass)}
          onChange={(event) => onChange({ ...condition, isClass: event.target.value === "true" })}
        >
          <option value="true">A class</option>
          <option value="false">Not a class</option>
        </select>
      );
    case "presentAsMain":
      return (
        <select
          aria-label="Placement"
          value={String(condition.presentAsMain)}
          onChange={(event) =>
            onChange({ ...condition, presentAsMain: event.target.value === "true" })
          }
        >
          <option value="true">Main children</option>
          <option value="false">Inline body</option>
        </select>
      );
    case "content":
      return (
        <input
          aria-label="Content"
          value={condition.value}
          onChange={(event) => onChange({ ...condition, value: event.target.value })}
        />
      );
    case "property":
      return <PropertyValue condition={condition} onChange={onChange} facts={facts} />;
    case "linkedTo":
      return (
        <NodePickBody
          nodeId={condition.nodeId}
          placeholder="Pick a node…"
          client={client}
          onPick={(nodeId) => onChange({ ...condition, nodeId })}
        />
      );
    case "descendantOf":
      return (
        <NodePickBody
          nodeId={condition.nodeId}
          placeholder="Pick a parent…"
          client={client}
          onPick={(nodeId) => onChange({ ...condition, nodeId })}
        />
      );
    case "linkedToQuery":
    case "descendantOfQuery":
      return <span className="nt-fb-condition__word">matching</span>;
    case "createdAfter":
    case "createdBefore":
    case "updatedAfter":
    case "updatedBefore":
      return (
        <input
          aria-label={condition.type.startsWith("updated") ? "Edited" : "Created"}
          list={datalistId}
          placeholder="{today} or 2026-10-04"
          value={condition.timestamp}
          onChange={(event) => onChange({ ...condition, timestamp: event.target.value })}
        />
      );
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return null;
  }
}

/** The property family's value column: schema select + typed value input
 * (the property-table register — numeric keyboard for number/integer). The
 * OPERATOR rides the operator column. */
function PropertyValue({
  condition,
  onChange,
  facts,
}: {
  condition: Extract<Condition, { type: "property" }>;
  onChange: (condition: Condition) => void;
  facts: BuilderFacts;
}) {
  const schema = facts.boundProperties.find((property) => property.id === condition.schemaId);
  const numeric = schema !== undefined && (schema.type === "number" || schema.type === "integer");
  return (
    <>
      <select
        aria-label="Property"
        value={condition.schemaId}
        onChange={(event) => onChange({ ...condition, schemaId: event.target.value })}
      >
        <option value="">Pick a property</option>
        {facts.boundProperties.map((property) => (
          <option key={property.id} value={property.id}>
            {property.name}
          </option>
        ))}
      </select>
      {condition.op !== "exists" && (
        <input
          aria-label="Value"
          type={numeric ? "number" : "text"}
          value={condition.value === undefined || condition.value === null ? "" : String(condition.value)}
          onChange={(event) => onChange({ ...condition, value: event.target.value })}
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
        onClick={() => setOpen(true)}
      >
        {target !== undefined ? displayNameForSettings(target) || "Untitled" : placeholder}
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
