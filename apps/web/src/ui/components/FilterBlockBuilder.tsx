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
 * each block is a row of COLUMNS: a TYPE dropdown (Class, Type, Structural role,
 * Content, Property, Links, Parent, Cover, Banner, Alias, Created, Edited),
 * an OPERATOR dropdown whose options vary by family — the class family
 * carries the Odoo set (owner 2026-10-16): is / is not (EXACT set
 * equality), contains / does not contain (closure membership), one of /
 * not one of (ANY-of membership), is set / is not set (emptiness); the
 * content/property/date families carry their own variation (full-text /
 * ordering / after / before — the negatives are not-wrap sugar, the
 * booleans flip their bit), then the VALUE
 * control (typed per family — the property-table register: numeric keyboard,
 * placeholder datalist, anchored node picker). The selection columns ride
 * the kit Dropdown register and the text values the kit Input (the boxed
 * field pairing with SelectTrigger — owner 2026-10-16: the raw native
 * <select>s rendered the browser's chrome, unaligned with the token
 * interface); the node-target families
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
  type DatePeriod,
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
import { Dropdown, type DropdownOption } from "./ui/Dropdown.js";
import { GridMenu } from "./ui/GridMenu.js";
import { Input } from "./ui/Input.js";
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
    case "contentSet":
      return "content";
    case "class":
    case "classExact":
    case "classAny":
    case "classSet":
      return "class";
    case "isClass":
      return "type";
    case "isEmbedded":
      return "placement";
    case "property":
    case "propertyBetween":
    case "propertyWithin":
      return "property";
    case "linkedTo":
    case "linkedToQuery":
    case "linkedToAny":
    case "linkSet":
      return "links";
    case "referencePathOf":
    case "referencePathOfQuery":
      return "referencePath";
    case "parentOf":
    case "parentOfQuery":
      return "parent";
    case "childOf":
    case "childOfQuery":
    case "childSet":
      return "child";
    case "descendantOf":
    case "descendantOfQuery":
    case "descendantOfAny":
    case "descendantSet":
      return "childPath";
    case "tag":
    case "tagAny":
    case "parentSet":
      return "parent";
    case "tagSet":
      return "tags";
    case "pageOf":
    case "pageOfQuery":
    case "pageSet":
      return "page";
    case "ancestorIn":
    case "ancestorInQuery":
      return "parentPath";
    case "rootIn":
    case "rootInQuery":
      return "root";
    case "coverAsset":
      return "cover";
    case "bannerAsset":
      return "banner";
    case "aliasedNode":
      return "alias";
    case "createdAfter":
    case "createdBefore":
    case "createdCmp":
    case "createdBetween":
    case "createdWithin":
      return "created";
    case "updatedAfter":
    case "updatedBefore":
    case "updatedCmp":
    case "updatedBetween":
    case "updatedWithin":
      return "edited";
    default:
      return "class";
  }
}

interface OperatorOption {
  value: string;
  label: string;
}

/** The operator column's options per family (the Odoo operator sets, owner
 * 2026-10-16). The property family's list adapts to the SELECTED schema's
 * type; the edited family carries the set/not-set pair (created_at is always
 * set — the options would lie). */
function operatorOptions(
  family: ConditionKind,
  condition: Condition | undefined,
  facts: BuilderFacts,
): readonly OperatorOption[] {
  switch (family) {
    case "class":
      // The class set: is/is not ride the EXACT register, contains/does not
      // contain ride closure MEMBERSHIP, one of/not one of ride ANY-of
      // membership, is set/is not set test the set's emptiness.
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        { value: "one-of", label: "one of" },
        { value: "not-one-of", label: "not one of" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "content":
      // The text operator set: exact/equality, substring, edge-anchored,
      // full-text, and the emptiness bit.
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        { value: "starts", label: "starts with" },
        { value: "ends", label: "ends with" },
        { value: "fts", label: "full-text" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "tags":
    case "links":
      // The link/tag families: is/is not (membership), one of/not one of
      // (ANY-of over picked nodes), is set/is not set (the reference exists).
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "one-of", label: "one of" },
        { value: "not-one-of", label: "not one of" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "referencePath":
      // v1's REFERENCE PATH: the self-or-ancestor link rollup (containment
      // folded in) over the picked nodes / the subquery's matches.
      return [
        { value: "is-any-of", label: "is any of" },
        { value: "is-not-any-of", label: "is not any of" },
      ];
    case "parent":
      // v1's PARENT: the direct parent is any of the picked nodes (or the
      // subquery's matches) — plus the has-a-parent set bit.
      return [
        { value: "is-any-of", label: "is any of" },
        { value: "is-not-any-of", label: "is not any of" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "child":
      // v1's CHILD: contains any of the picked nodes as DIRECT children.
      return [
        { value: "contains-any-of", label: "contains any of" },
        { value: "not-contains-any-of", label: "does not contain any of" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "childPath":
      // v1's CHILD PATH: contains any of the picked nodes anywhere down
      // their tree (the v1 "contains" wording).
      return [
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
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
    case "page":
      // v1's Page block: the containing page is any of the picked nodes (or
      // the subquery's matches) — plus the lives-inside-a-page set bit.
      return [
        { value: "is-any-of", label: "is any of" },
        { value: "is-not-any-of", label: "is not any of" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "parentPath":
      // v1's Parent path block: the ancestor chain includes any of the
      // picked nodes (or the subquery's matches) — the v1 "includes" wording.
      return [
        { value: "includes", label: "includes" },
        { value: "not-includes", label: "does not include" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "root":
      // The root walk: the workspace-root ancestor is any of the picked
      // nodes (or the subquery's matches). The set bit is vacuous — every
      // node's root exists (a parentless row is its own root).
      return [
        { value: "is-any-of", label: "is any of" },
        { value: "is-not-any-of", label: "is not any of" },
      ];
    case "property":
      return propertyOperatorOptions(condition, facts);
    case "cover":
    case "banner":
    case "alias":
      return [
        { value: "exists", label: "is set" },
        { value: "not-exists", label: "is not set" },
      ];
    case "created":
    case "edited": {
      // The date operator set (Odoo's date list): day-granular equality, the
      // instant comparisons, the inclusive range, the relative period. The
      // set bits are deliberately absent — created_at/updated_at are written
      // at create time, so every row reads "set" (a lying control).
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "gt", label: ">" },
        { value: "gte", label: "≥" },
        { value: "lt", label: "<" },
        { value: "lte", label: "≤" },
        { value: "between", label: "is between" },
        { value: "within", label: "is within" },
      ];
    }
  }
}

/** The property family's operator list, adapted to the selected schema's type. */
function propertyOperatorOptions(
  condition: Condition | undefined,
  facts: BuilderFacts,
): readonly OperatorOption[] {
  const schemaId = condition?.type === "property" || condition?.type === "propertyBetween" || condition?.type === "propertyWithin"
    ? condition.schemaId
    : "";
  const schema = facts.boundProperties.find((property) => property.id === schemaId);
  const set = [
    { value: "set", label: "is set" },
    { value: "not-set", label: "is not set" },
  ] as const;
  switch (schema?.type) {
    case "number":
    case "integer":
      // Odoo's numeric list: =/!=/>/>=/</<=, the range, the substring ops.
      return [
        { value: "eq", label: "=" },
        { value: "neq", label: "≠" },
        { value: "gt", label: ">" },
        { value: "gte", label: "≥" },
        { value: "lt", label: "<" },
        { value: "lte", label: "≤" },
        { value: "between", label: "is between" },
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        ...set,
      ];
    case "datetime":
      // The date list: the comparisons, the range, the relative period.
      return [
        { value: "eq", label: "=" },
        { value: "neq", label: "≠" },
        { value: "gt", label: ">" },
        { value: "gte", label: "≥" },
        { value: "lt", label: "<" },
        { value: "lte", label: "≤" },
        { value: "between", label: "is between" },
        { value: "within", label: "is within" },
        ...set,
      ];
    case "select":
      return [
        { value: "eq", label: "is" },
        { value: "neq", label: "is not" },
        ...set,
      ];
    case "boolean":
      return [
        { value: "is-true", label: "is true" },
        { value: "is-false", label: "is false" },
        ...set,
      ];
    case "object":
      // Node-typed: the value control is the anchored node picker.
      return [
        { value: "eq", label: "is" },
        { value: "neq", label: "is not" },
        ...set,
      ];
    default:
      // Text and the rest: the text set.
      return [
        { value: "eq", label: "is" },
        { value: "neq", label: "is not" },
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        ...set,
      ];
  }
}

/** The operator column's current value for a condition (+ its negation). */
function operatorOf(condition: Condition, negated: boolean): string {
  switch (condition.type) {
    case "class":
      // Closure membership (the plain `class` condition rides contains).
      return negated ? "not-contains" : "contains";
    case "classExact":
      return negated ? "is-not" : "is";
    case "classAny":
      return negated ? "not-one-of" : "one-of";
    case "classSet":
      return negated ? "not-set" : "set";
    case "content":
      if (condition.op === "fts") return "fts";
      if (condition.op === "eq") return negated ? "is-not" : "is";
      if (condition.op === "starts") return "starts";
      if (condition.op === "ends") return "ends";
      return negated ? "not-contains" : "contains";
    case "contentSet":
      return negated ? "not-set" : "set";
    case "tag":
      return negated ? "is-not" : "is";
    case "tagAny":
      return negated ? "not-one-of" : "one-of";
    case "tagSet":
      return negated ? "not-set" : "set";
    case "linkedTo":
    case "linkedToQuery":
      return negated ? "is-not" : "is";
    case "linkedToAny":
      return negated ? "not-one-of" : "one-of";
    case "linkSet":
      return negated ? "not-set" : "set";
    case "descendantOf":
    case "descendantOfQuery":
      return negated ? "is-not" : "is";
    case "descendantOfAny":
      return negated ? "not-contains" : "contains";
    case "descendantSet":
      return negated ? "not-set" : "set";
    case "parentOf":
    case "parentOfQuery":
      return negated ? "is-not-any-of" : "is-any-of";
    case "parentSet":
      return negated ? "not-set" : "set";
    case "childOf":
    case "childOfQuery":
      return negated ? "not-contains-any-of" : "contains-any-of";
    case "childSet":
      return negated ? "not-set" : "set";
    case "referencePathOf":
    case "referencePathOfQuery":
      return negated ? "is-not-any-of" : "is-any-of";
    case "pageOf":
    case "pageOfQuery":
      return negated ? "is-not-any-of" : "is-any-of";
    case "pageSet":
      return negated ? "not-set" : "set";
    case "ancestorIn":
    case "ancestorInQuery":
      return negated ? "not-includes" : "includes";
    case "rootIn":
    case "rootInQuery":
      return negated ? "is-not-any-of" : "is-any-of";
    case "isClass":
      return condition.isClass ? "is" : "is-not";
    case "isEmbedded":
      return condition.isEmbedded ? "is" : "is-not";
    case "property":
      if (condition.op === "exists") return negated ? "not-set" : "set";
      if (condition.op === "eq" && typeof condition.value === "boolean") {
        const truth = negated ? !condition.value : condition.value;
        return truth ? "is-true" : "is-false";
      }
      return condition.op;
    case "propertyBetween":
      return "between";
    case "propertyWithin":
      return "within";
    case "createdAfter":
      return "after";
    case "createdBefore":
      return "before";
    case "createdCmp":
      if (condition.op === "eq") return negated ? "is-not" : "is";
      if (condition.op === "neq") return negated ? "is" : "is-not";
      return condition.op;
    case "createdBetween":
      return "between";
    case "createdWithin":
      return "within";
    case "updatedAfter":
      return "after";
    case "updatedBefore":
      return "before";
    case "updatedCmp":
      if (condition.op === "eq") return negated ? "is-not" : "is";
      if (condition.op === "neq") return negated ? "is" : "is-not";
      return condition.op;
    case "updatedBetween":
      return "between";
    case "updatedWithin":
      return "within";
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return negated ? "not-exists" : "exists";
  }
}

/**
 * The class family's operator application (owner 2026-10-16, the Odoo set):
 * is / is not → EXACT set equality, contains / does not contain → closure
 * membership, one of / not one of → ANY-of membership, is set / is not set →
 * emptiness. The picked ids carry across the morphs so switching operators
 * keeps the selection.
 */
function applyClassOperator(condition: Condition, op: string): Child {
  const carried: string[] =
    condition.type === "classAny"
      ? condition.classIds
      : (condition.type === "class" || condition.type === "classExact") && condition.classId !== ""
        ? [condition.classId]
        : [];
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (op) {
    case "is":
      return { type: "classExact", classId: carried[0] ?? "" };
    case "is-not":
      return neg({ type: "classExact", classId: carried[0] ?? "" });
    case "contains":
      return { type: "class", classId: carried[0] ?? "" };
    case "not-contains":
      return neg({ type: "class", classId: carried[0] ?? "" });
    case "one-of":
      return { type: "classAny", classIds: carried };
    case "not-one-of":
      return neg({ type: "classAny", classIds: carried });
    case "set":
      return { type: "classSet" };
    case "not-set":
      return neg({ type: "classSet" });
    default:
      return condition;
  }
}

/** Carried ids for the node-target families (links / parent / tags morphs). */
function carriedNodeIds(condition: Condition): string[] {
  if (condition.type === "tagAny") return condition.tagIds;
  if (
    condition.type === "linkedToAny" ||
    condition.type === "descendantOfAny" ||
    condition.type === "pageOf" ||
    condition.type === "ancestorIn" ||
    condition.type === "rootIn" ||
    condition.type === "parentOf" ||
    condition.type === "childOf" ||
    condition.type === "referencePathOf"
  ) {
    return condition.nodeIds;
  }
  if (condition.type === "linkedTo" || condition.type === "descendantOf") {
    return condition.nodeId !== "" ? [condition.nodeId] : [];
  }
  if (condition.type === "tag") {
    return condition.tagId !== "" ? [condition.tagId] : [];
  }
  return [];
}

/** The node-target morph: is/is not (single), one of/not one of (multi), is set/is not set. */
function applyNodeTargetOperator(
  condition: Condition,
  op: string,
  single: (id: string) => Condition,
  any: (ids: string[]) => Condition,
  setType: Condition,
): Child {
  const carried = carriedNodeIds(condition);
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (op) {
    case "is":
      return single(carried[0] ?? "");
    case "is-not":
      return neg(single(carried[0] ?? ""));
    case "one-of":
      return any(carried);
    case "not-one-of":
      return neg(any(carried));
    case "set":
      return setType;
    case "not-set":
      return neg(setType);
    default:
      return condition;
  }
}

/**
 * The node-container morph (v1's Page / Parent path / Root blocks): the
 * static pick and the dynamic subquery share one operator pair (is any of /
 * is not any of — "includes" on the parent path), plus the set bits where
 * they mean something (Page is set = lives inside a page; Parent path is
 * set = has an ancestor at all; Root's set bit is vacuous — never offered).
 */
function applyContainerNodeOperator(
  condition: Condition,
  op: string,
  kind: "page" | "path" | "root",
): Child {
  const carried: string[] =
    condition.type === "pageOf" || condition.type === "ancestorIn" || condition.type === "rootIn"
      ? condition.nodeIds
      : [];
  const single =
    kind === "page"
      ? (nodeIds: string[]): Condition => ({ type: "pageOf", nodeIds })
      : kind === "path"
        ? (nodeIds: string[]): Condition => ({ type: "ancestorIn", nodeIds })
        : (nodeIds: string[]): Condition => ({ type: "rootIn", nodeIds });
  // The parent-path "is set" IS "has a parent" (parentSet); the page's is
  // "lives inside a page" (pageSet).
  const setType: Condition =
    kind === "page" ? { type: "pageSet" } : kind === "path" ? { type: "parentSet" } : condition;
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (op) {
    case "is-any-of":
    case "includes":
      return single(carried);
    case "is-not-any-of":
    case "not-includes":
      return neg(single(carried));
    case "set":
      return setType;
    case "not-set":
      return neg(setType);
    default:
      return condition;
  }
}

/**
 * The generic node-target morph for the v1 pick-set families (Parent direct /
 * Child / Child path / Reference path): a positive/negative operator pair
 * over the picked-id set, plus an optional set bit. The picked ids carry
 * across the morphs; the dynamic (*Query) shapes re-enter through the same
 * operators (the value column is the subquery then).
 */
function applyPickSetOperator(
  condition: Condition,
  op: string,
  positiveOp: string,
  negativeOp: string,
  single: (nodeIds: string[]) => Condition,
  setType: Condition | null,
): Child {
  const carried = carriedNodeIds(condition);
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  if (op === positiveOp) return single(carried);
  if (op === negativeOp) return neg(single(carried));
  if (setType !== null && op === "set") return setType;
  if (setType !== null && op === "not-set") return neg(setType);
  return condition;
}

/** The content morph: the text operator set + the emptiness bit. */
function applyContentOperator(condition: Condition, op: string): Child {
  const carried = condition.type === "content" ? condition.value : "";
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  const text = (contentOp: "eq" | "contains" | "starts" | "ends" | "fts", value: string): Condition => ({
    type: "content",
    op: contentOp,
    value,
  });
  switch (op) {
    case "is":
      return text("eq", carried);
    case "is-not":
      return neg(text("eq", carried));
    case "contains":
      return text("contains", carried);
    case "not-contains":
      return neg(text("contains", carried));
    case "starts":
      return text("starts", carried);
    case "ends":
      return text("ends", carried);
    case "fts":
      return text("fts", carried);
    case "set":
      return { type: "contentSet" };
    case "not-set":
      return neg({ type: "contentSet" });
    default:
      return condition;
  }
}

/** The date morph (created / edited): comparisons carry the timestamp, the range carries it into `from`. */
function applyDateOperator(condition: Condition, op: string, edited: boolean): Child {
  const carried =
    condition.type === "createdCmp" || condition.type === "updatedCmp"
      ? condition.timestamp
      : (condition.type === "createdAfter" || condition.type === "updatedAfter" || condition.type === "createdBefore" || condition.type === "updatedBefore" || condition.type === "createdBetween" || condition.type === "updatedBetween")
        ? (condition as { timestamp?: string; from?: string }).timestamp ??
          (condition as { from?: string }).from ??
          ""
        : "";
  const cmp = (dateOp: "eq" | "neq" | "gt" | "gte" | "lt" | "lte", timestamp: string): Condition =>
    edited
      ? { type: "updatedCmp", op: dateOp, timestamp }
      : { type: "createdCmp", op: dateOp, timestamp };
  const between = (from: string, to: string): Condition =>
    edited ? { type: "updatedBetween", from, to } : { type: "createdBetween", from, to };
  const within = (period: "today" | "this_week" | "this_month" | "this_year"): Condition =>
    edited ? { type: "updatedWithin", period } : { type: "createdWithin", period };
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (op) {
    case "is":
      return cmp("eq", carried);
    case "is-not":
      return neg(cmp("eq", carried));
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return cmp(op, carried);
    case "after":
      return edited
        ? { type: "updatedAfter", timestamp: carried }
        : { type: "createdAfter", timestamp: carried };
    case "before":
      return edited
        ? { type: "updatedBefore", timestamp: carried }
        : { type: "createdBefore", timestamp: carried };
    case "between":
      return between(carried, carried);
    case "within":
      return within("today");
    case "set":
    case "not-set":
      // The date set bits are vacuous: created_at/updated_at are written at
      // create time, so every row reads "set" — no honest control to offer.
      return condition;
    default:
      return condition;
  }
}

/** The property morph: the op carries the value across; between/within keep the schema. */
function applyPropertyOperator(condition: Condition, op: string): Child {
  const schemaId =
    condition.type === "property" || condition.type === "propertyBetween" || condition.type === "propertyWithin"
      ? condition.schemaId
      : "";
  const carried = condition.type === "property" ? condition.value : undefined;
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  const value = (propertyOp: "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte", v: unknown): Condition => ({
    type: "property",
    schemaId,
    op: propertyOp,
    ...(v !== undefined ? { value: v } : {}),
  });
  switch (op) {
    case "eq":
      return value("eq", carried);
    case "neq":
      return value("neq", carried);
    case "contains":
      return value("contains", carried);
    case "not-contains":
      return neg(value("contains", carried));
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return value(op, carried);
    case "is-true":
      return value("eq", true);
    case "is-false":
      return value("eq", false);
    case "between":
      return { type: "propertyBetween", schemaId, from: carried, to: undefined };
    case "within":
      return { type: "propertyWithin", schemaId, period: "today" };
    case "set":
      return { type: "property", schemaId, op: "exists" };
    case "not-set":
      return neg({ type: "property", schemaId, op: "exists" });
    default:
      return condition;
  }
}

/**
 * Apply an operator choice to a block's condition, returning the new child
 * (not-wrapped where the operator is negative). The picked ids / values /
 * timestamps carry across the operator morphs; the boolean families flip
 * their bit instead of wrapping.
 */
function applyOperator(condition: Condition, op: string): Child {
  const wrap = (next: Condition): Child => next;
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (condition.type) {
    case "class":
    case "classExact":
    case "classAny":
    case "classSet":
      return applyClassOperator(condition, op);
    case "content":
    case "contentSet":
      return applyContentOperator(condition, op);
    case "tag":
    case "tagAny":
    case "tagSet":
      return applyNodeTargetOperator(
        condition,
        op,
        (tagId) => ({ type: "tag", tagId }),
        (tagIds) => ({ type: "tagAny", tagIds }),
        { type: "tagSet" },
      );
    case "linkedTo":
    case "linkedToAny":
    case "linkSet":
      return applyNodeTargetOperator(
        condition,
        op,
        (nodeId) => ({ type: "linkedTo", nodeId }),
        (nodeIds) => ({ type: "linkedToAny", nodeIds }),
        { type: "linkSet" },
      );
    case "parentOf":
    case "parentOfQuery":
      return applyPickSetOperator(
        condition,
        op,
        "is-any-of",
        "is-not-any-of",
        (nodeIds) => ({ type: "parentOf", nodeIds }),
        { type: "parentSet" },
      );
    case "childOf":
    case "childOfQuery":
    case "childSet":
      return applyPickSetOperator(
        condition,
        op,
        "contains-any-of",
        "not-contains-any-of",
        (nodeIds) => ({ type: "childOf", nodeIds }),
        { type: "childSet" },
      );
    case "descendantOf":
    case "descendantOfAny":
    case "descendantOfQuery":
    case "descendantSet":
      return applyPickSetOperator(
        condition,
        op,
        "contains",
        "not-contains",
        (nodeIds) => ({ type: "descendantOfAny", nodeIds }),
        { type: "descendantSet" },
      );
    case "referencePathOf":
    case "referencePathOfQuery":
      return applyPickSetOperator(
        condition,
        op,
        "is-any-of",
        "is-not-any-of",
        (nodeIds) => ({ type: "referencePathOf", nodeIds }),
        null,
      );
    case "parentSet":
      // The Parent family's set bit — every operator choice on it keeps it
      // (its operator list is only set / not-set, its own states).
      return condition;
    case "pageOf":
    case "pageOfQuery":
    case "pageSet":
      return applyContainerNodeOperator(condition, op, "page");
    case "ancestorIn":
    case "ancestorInQuery":
      return applyContainerNodeOperator(condition, op, "path");
    case "rootIn":
    case "rootInQuery":
      return applyContainerNodeOperator(condition, op, "root");
    case "createdAfter":
    case "createdBefore":
    case "createdCmp":
    case "createdBetween":
    case "createdWithin":
      return applyDateOperator(condition, op, false);
    case "updatedAfter":
    case "updatedBefore":
    case "updatedCmp":
    case "updatedBetween":
    case "updatedWithin":
      return applyDateOperator(condition, op, true);
    case "property":
    case "propertyBetween":
    case "propertyWithin":
      return applyPropertyOperator(condition, op);
    case "isClass":
      return { ...condition, isClass: op !== "is-not" };
    case "isEmbedded":
      return { ...condition, isEmbedded: op !== "is-not" };
    case "linkedToQuery":
      return op === "is-not" ? neg(condition) : wrap(condition);
    case "descendantOfQuery":
      return op === "is-not" ? neg(condition) : wrap(condition);
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return op === "not-exists" ? neg(condition) : wrap(condition);
    default:
      return condition;
  }
}

const FAMILY_OPTIONS: readonly { value: ConditionKind; label: string }[] = FILTER_KIND_OPTIONS.filter(
  (option): option is { value: ConditionKind; label: string; icon: string; description: string } =>
    option.value !== "group-and" && option.value !== "group-or" && option.value !== "not",
);

const FAMILY_LABELS: Record<ConditionKind, string> = Object.fromEntries(
  FAMILY_OPTIONS.map((option) => [option.value, option.label]),
) as Record<ConditionKind, string>;

/** The TYPE column's options — the add-menu register, icons carried over. */
const FAMILY_DROPDOWN_OPTIONS: DropdownOption<string>[] = FILTER_KIND_OPTIONS.filter(
  (option) => option.value !== "group-and" && option.value !== "group-or" && option.value !== "not",
).map((option) => ({
  value: option.value,
  label: option.label,
  icon: option.icon,
  description: option.description,
}));

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
  /** The node-target families: static (picked node(s)) or dynamic (a nested
   * query defining the target set — the v1 static/dynamic switch, now on
   * links / parent / page / parent path / root alike). */
  const dynamic =
    condition.type === "linkedToQuery" ||
    condition.type === "descendantOfQuery" ||
    condition.type === "pageOfQuery" ||
    condition.type === "ancestorInQuery" ||
    condition.type === "rootInQuery" ||
    condition.type === "parentOfQuery" ||
    condition.type === "childOfQuery" ||
    condition.type === "referencePathOfQuery";
  return (
    <div className="nt-fb-block">
      <div className="nt-fb-block__row">
        {/* The TYPE column — morphing the block replaces the condition,
            keeping the negation where one was set. */}
        <div className="nt-fb-block__type">
          <Dropdown
            size="sm"
            ariaLabel="Block type"
            options={FAMILY_DROPDOWN_OPTIONS}
            value={family}
            onChange={(value) => {
              if (value === null) return;
              const next = createCondition(value as ConditionKind);
              onChange(negated ? { type: "not", child: next } : next);
            }}
          />
        </div>
        <div className="nt-fb-block__operator">
          <Dropdown
            size="sm"
            ariaLabel="Operator"
            options={operatorOptions(family, condition, facts).map((option) => ({ value: option.value, label: option.label }))}
            value={operatorOf(condition, negated)}
            onChange={(value) => {
              if (value !== null) onChange(applyOperator(condition, value));
            }}
          />
        </div>
        <div className="nt-fb-block__value">
          <BlockValue
            condition={condition}
            onChange={(next) => onChange(negated ? { type: "not", child: next } : next)}
            client={client}
            facts={facts}
            datalistId={datalistId}
          />
        </div>
        {(family === "links" ||
          family === "referencePath" ||
          family === "parent" ||
          family === "child" ||
          family === "childPath" ||
          family === "page" ||
          family === "parentPath" ||
          family === "root") && (
          <SelectionButton
            size="sm"
            aria-label="Target mode"
            options={[
              { value: "static", icon: "mdi mdi-pin-outline", label: "Static — picked nodes" },
              { value: "dynamic", icon: "mdi mdi-filter-variant", label: "Dynamic — a nested query" },
            ]}
            value={dynamic ? "dynamic" : "static"}
            onChange={(mode) => {
              const empty = { type: "group", logic: "and", children: [] } as Group;
              const dynamicFor = (type: string): Condition => ({ type, root: empty } as Condition);
              const staticFor = (type: string): Condition =>
                type === "linkedTo" || type === "descendantOf"
                  ? ({ type, nodeId: "" } as Condition)
                  : ({ type, nodeIds: [] } as Condition);
              const dynamicType =
                family === "links"
                  ? "linkedToQuery"
                  : family === "referencePath"
                    ? "referencePathOfQuery"
                    : family === "parent"
                      ? "parentOfQuery"
                      : family === "child"
                        ? "childOfQuery"
                        : family === "childPath"
                          ? "descendantOfQuery"
                          : family === "page"
                            ? "pageOfQuery"
                            : family === "parentPath"
                              ? "ancestorInQuery"
                              : "rootInQuery";
              const staticType =
                family === "links"
                  ? "linkedTo"
                  : family === "referencePath"
                    ? "referencePathOf"
                    : family === "parent"
                      ? "parentOf"
                      : family === "child"
                        ? "childOf"
                        : family === "childPath"
                          ? "descendantOfAny"
                          : family === "page"
                            ? "pageOf"
                            : family === "parentPath"
                              ? "ancestorIn"
                              : "rootIn";
              const next = mode === "dynamic" ? dynamicFor(dynamicType) : staticFor(staticType);
              onChange(negated ? { type: "not", child: next } : next);
            }}
          />
        )}
        <span className="nt-fb-block__spacer" />
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

/** The single class pick shared by the class / page / parent-path / root value columns. */
function ClassPick({
  ariaLabel,
  value,
  facts,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  facts: BuilderFacts;
  onChange: (classId: string) => void;
}) {
  return (
    <Dropdown
      size="sm"
      ariaLabel={ariaLabel}
      options={[
        { value: "", label: "Pick a class" },
        ...facts.classes.map((cls) => ({
          value: cls.id,
          label: facts.classNames.get(cls.id) ?? cls.id,
        })),
      ]}
      value={value}
      onChange={(next) => {
        if (next !== null) onChange(next);
      }}
    />
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
    case "classExact":
      return (
        <ClassPick
          ariaLabel="Class"
          value={condition.classId}
          facts={facts}
          onChange={(classId) => onChange({ ...condition, classId })}
        />
      );
    case "classAny":
      // "One of": ANY-of membership — a multi class pick.
      return (
        <ClassMultiPick
          ariaLabel="Classes"
          values={condition.classIds}
          facts={facts}
          onChange={(classIds) => onChange({ ...condition, classIds })}
        />
      );
    case "classSet":
    case "pageSet":
    case "childSet":
    case "descendantSet":
    case "tagSet":
    case "linkSet":
    case "parentSet":
    case "contentSet":
      // The set operators carry no value — the operator column IS the condition.
      return null;
    case "pageOf":
      // v1's Page block (static): the containing page is any of the picked
      // nodes.
      return (
        <NodeMultiPick
          ariaLabel="Pages"
          nodeIds={condition.nodeIds}
          addLabel="Add page"
          client={client}
          onChange={(nodeIds) => onChange({ ...condition, nodeIds })}
        />
      );
    case "pageOfQuery":
      return <span className="nt-fb-block__word">matching</span>;
    case "ancestorIn":
      // v1's Parent path block (static): some strict ancestor is one of the
      // picked nodes.
      return (
        <NodeMultiPick
          ariaLabel="Ancestors"
          nodeIds={condition.nodeIds}
          addLabel="Add ancestor"
          client={client}
          onChange={(nodeIds) => onChange({ ...condition, nodeIds })}
        />
      );
    case "ancestorInQuery":
      return <span className="nt-fb-block__word">matching</span>;
    case "rootIn":
      return (
        <NodeMultiPick
          ariaLabel="Roots"
          nodeIds={condition.nodeIds}
          addLabel="Add root"
          client={client}
          onChange={(nodeIds) => onChange({ ...condition, nodeIds })}
        />
      );
    case "rootInQuery":
      return <span className="nt-fb-block__word">matching</span>;
    case "isClass":
      return (
        <Dropdown
          size="sm"
          ariaLabel="Type"
          options={[
            { value: "true", label: "A class" },
            { value: "false", label: "Not a class" },
          ]}
          value={String(condition.isClass)}
          onChange={(value) => {
            if (value !== null) onChange({ ...condition, isClass: value === "true" });
          }}
        />
      );
    case "isEmbedded":
      return (
        <Dropdown
          size="sm"
          ariaLabel="Structural role"
          options={[
            { value: "true", label: "Block (embedded in body)" },
            { value: "false", label: "Page (standalone)" },
          ]}
          value={String(condition.isEmbedded)}
          onChange={(value) => {
            if (value !== null) onChange({ ...condition, isEmbedded: value === "true" });
          }}
        />
      );
    case "content":
      return (
        <Input
          size="sm"
          aria-label="Content"
          value={condition.value}
          onChange={(event) => onChange({ ...condition, value: event.target.value })}
        />
      );
    case "property":
      return <PropertyValue condition={condition} onChange={onChange} facts={facts} client={client} datalistId={datalistId} />;
    case "propertyBetween":
      return <PropertyValue condition={condition} onChange={onChange} facts={facts} client={client} datalistId={datalistId} />;
    case "propertyWithin":
      return <PropertyValue condition={condition} onChange={onChange} facts={facts} client={client} datalistId={datalistId} />;
    case "parentOf":
      // v1's PARENT block (static): the direct parent is any of the picked nodes.
      return (
        <NodeMultiPick
          ariaLabel="Parents"
          nodeIds={condition.nodeIds}
          addLabel="Add parent"
          client={client}
          onChange={(nodeIds) => onChange({ ...condition, nodeIds })}
        />
      );
    case "parentOfQuery":
      return <span className="nt-fb-block__word">matching</span>;
    case "childOf":
      // v1's CHILD block (static): a direct child is any of the picked nodes.
      return (
        <NodeMultiPick
          ariaLabel="Children"
          nodeIds={condition.nodeIds}
          addLabel="Add child"
          client={client}
          onChange={(nodeIds) => onChange({ ...condition, nodeIds })}
        />
      );
    case "childOfQuery":
      return <span className="nt-fb-block__word">matching</span>;
    case "descendantOfAny":
      // v1's CHILD PATH block (static): the subtree contains any of the picks.
      return (
        <NodeMultiPick
          ariaLabel="Targets"
          nodeIds={condition.nodeIds}
          addLabel="Add node"
          client={client}
          onChange={(nodeIds) => onChange({ ...condition, nodeIds })}
        />
      );
    case "descendantOfQuery":
      return <span className="nt-fb-block__word">matching</span>;
    case "referencePathOf":
      // v1's REFERENCE PATH block (static): the self-or-ancestor link rollup.
      return (
        <NodeMultiPick
          ariaLabel="Targets"
          nodeIds={condition.nodeIds}
          addLabel="Add target"
          client={client}
          onChange={(nodeIds) => onChange({ ...condition, nodeIds })}
        />
      );
    case "referencePathOfQuery":
      return <span className="nt-fb-block__word">matching</span>;
    case "tag":
      return (
        <NodePickBody
          nodeId={condition.tagId}
          placeholder="Pick a tag…"
          client={client}
          onPick={(tagId) => onChange({ ...condition, tagId })}
        />
      );
    case "tagAny":
      return (
        <NodeMultiPick
          ariaLabel="Tags"
          nodeIds={condition.tagIds}
          addLabel="Add tag"
          client={client}
          onChange={(tagIds) => onChange({ ...condition, tagIds })}
        />
      );
    case "linkedTo":
      return (
        <NodePickBody
          nodeId={condition.nodeId}
          placeholder="Pick a node…"
          client={client}
          onPick={(nodeId) => onChange({ ...condition, nodeId })}
        />
      );
    case "linkedToAny":
      return (
        <NodeMultiPick
          ariaLabel="Nodes"
          nodeIds={condition.nodeIds}
          addLabel="Add node"
          client={client}
          onChange={(nodeIds) => onChange({ ...condition, nodeIds })}
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
    case "descendantOfAny":
      return (
        <NodeMultiPick
          ariaLabel="Parents"
          nodeIds={condition.nodeIds}
          addLabel="Add parent"
          client={client}
          onChange={(nodeIds) => onChange({ ...condition, nodeIds })}
        />
      );
    case "linkedToQuery":
    case "descendantOfQuery":
      return <span className="nt-fb-block__word">matching</span>;
    case "createdAfter":
    case "createdBefore":
    case "updatedAfter":
    case "updatedBefore":
    case "createdCmp":
    case "updatedCmp":
      return (
        <Input
          size="sm"
          aria-label={condition.type.startsWith("updated") ? "Edited" : "Created"}
          list={datalistId}
          placeholder="{today} or 2026-10-04"
          value={condition.timestamp}
          onChange={(event) => onChange({ ...condition, timestamp: event.target.value })}
        />
      );
    case "createdBetween":
    case "updatedBetween":
      return (
        <>
          <Input
            size="sm"
            aria-label="From"
            list={datalistId}
            placeholder="from {today}"
            value={condition.from}
            onChange={(event) => onChange({ ...condition, from: event.target.value })}
          />
          <Input
            size="sm"
            aria-label="To"
            list={datalistId}
            placeholder="to {today}"
            value={condition.to}
            onChange={(event) => onChange({ ...condition, to: event.target.value })}
          />
        </>
      );
    case "createdWithin":
    case "updatedWithin":
      return (
        <PeriodPick
          ariaLabel="Period"
          value={condition.period}
          onChange={(period) => onChange({ ...condition, period })}
        />
      );
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return null;
  }
}

/** The multi class pick shared by the ANY-of value columns. */
function ClassMultiPick({
  ariaLabel,
  values,
  facts,
  onChange,
}: {
  ariaLabel: string;
  values: string[];
  facts: BuilderFacts;
  onChange: (classIds: string[]) => void;
}) {
  return (
    <Dropdown
      size="sm"
      multiple
      ariaLabel={ariaLabel}
      placeholder="Pick classes"
      options={facts.classes.map((cls) => ({
        value: cls.id,
        label: facts.classNames.get(cls.id) ?? cls.id,
      }))}
      values={values}
      onChangeMultiple={onChange}
    />
  );
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

/** The property family's value column: schema select + a value control that
 * adapts to the SELECTED schema's type (the Odoo register, owner 2026-10-16):
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
  condition: Extract<Condition, { type: "property" | "propertyBetween" | "propertyWithin" }>;
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
  return (
    <>
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
        value={condition.schemaId}
        onChange={(value) => {
          // A different schema resets the value — the old one was typed for
          // the old type (boolean true is not a number bound).
          if (value !== null) onChange({ type: "property", schemaId: value, op: "eq", value: "" });
        }}
      />
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
      {condition.type === "property" && condition.op !== "exists" && schema?.type === "boolean" && (
        <Dropdown
          size="sm"
          ariaLabel="Value"
          options={[
            { value: "true", label: "True" },
            { value: "false", label: "False" },
          ]}
          value={typeof condition.value === "boolean" ? String(condition.value) : ""}
          onChange={(value) => {
            if (value !== null) patch({ value: value === "true" });
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
      {condition.type === "propertyBetween" && (
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
      {condition.type === "propertyWithin" && (
        <PeriodPick ariaLabel="Period" value={condition.period} onChange={(period) => patch({ period })} />
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
          {target !== undefined ? displayNameForSettings(target) || "Untitled" : placeholder}
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
 * The multi node pick (the "one of" value over node targets — links / parent /
 * tags): picked nodes ride as removable chips, the anchored NodeSelector
 * appends one at a time. Node targets are unbounded, so the multi pick is a
 * chip list + search, never a dropdown.
 */
function NodeMultiPick({
  ariaLabel,
  nodeIds,
  addLabel,
  client,
  onChange,
}: {
  ariaLabel: string;
  nodeIds: string[];
  addLabel: string;
  client: AnyClient;
  onChange: (nodeIds: string[]) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <span className="nt-fb-multipick" aria-label={ariaLabel}>
      {nodeIds.map((nodeId) => {
        const node = client.getNode(nodeId);
        const label = node !== undefined ? displayNameForSettings(node) || "Untitled" : nodeId;
        return (
          <span key={nodeId} className="nt-fb-multipick__chip">
            {label}
            <button
              type="button"
              className="nt-fb-multipick__remove"
              aria-label={`Remove ${label}`}
              title="Remove"
              onClick={() => onChange(nodeIds.filter((id) => id !== nodeId))}
            >
              ×
            </button>
          </span>
        );
      })}
      <button
        type="button"
        ref={anchorRef}
        className="nt-fb-multipick__add"
        aria-label={addLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        + {addLabel}
      </button>
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
