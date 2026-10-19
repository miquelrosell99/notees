/**
 * FilterBlockBuilder — the FilterBar's structured panel: the v1
 * query-builder block UI ported over the v2 query AST.
 * One feature file pair with FilterBlockBuilder.css (the SectionViewTabs
 * precedent), composed from kit primitives only.
 *
 * The chrome is FLAT, matching the app's list surfaces — no containing
 * cards (card-in-card read as a modal; the kit Card
 * lives only on the transient add-menu popover, the one surface elevation
 * is legal): the root group is a bare column (logic toggle + count on one
 * quiet line), nested groups indent under a left hairline, and condition
 * rows are list rows — transparent with a hover fill.
 *
 * The registers are the v1 ones (the 1:1 block model;
 * the row IDENTITY is READONLY once added — the Notion/
 * Odoo field → operator → value register: no row morphing, a kind change is
 * delete + re-add) — each block is a row of COLUMNS: a TYPE slot (a static
 * label naming the family — except the PROPERTY family, where the schema
 * dropdown rides the slot so the row reads [Property ▾] [Operator ▾]
 * [Value]), an OPERATOR dropdown whose options vary by family — the class
 * family carries the Odoo set: is / is not (EXACT set
 * equality), contains / does not contain (closure membership), one of /
 * not one of (ANY-of membership), is set / is not set (emptiness); the
 * content/property/date families carry their own variation (full-text /
 * ordering / after / before — the negatives are not-wrap sugar, the
 * booleans flip their bit), then the VALUE
 * control (typed per family — the property-table register: numeric keyboard,
 * placeholder datalist, anchored node picker). The selection columns ride
 * the kit Dropdown register and the text values the kit Input (the boxed
 * field pairing with SelectTrigger: the raw native
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
  type AddMenuEntry,
  type FilterBarConfig,
} from "./filterQuery.js";
import {
  applyOperator,
  blockView,
  familyOf,
  FAMILY_LABELS,
  FAMILY_OPTIONS,
  operatorOf,
  operatorOptions,
  propertyOperatorOptions,
} from "./filterBlockModel.js";
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
   * the popup reads as wide as the query builder it feeds).
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

  // The root level is NOT a group — no count label, no
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
            button. The popup spans the builder container
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
        {/* The TYPE column — the row's IDENTITY, readonly once added (the Notion/Odoo register — no row morphing; changing
            a row's kind is delete + re-add through the add menu). The
            PROPERTY family is the exception the owner carved out: the
            property pick IS the row's identity, so the schema dropdown rides
            this slot — reading [Property ▾] [Operator ▾] [Value]. */}
        <div className="nt-fb-block__type">
          {family === "property" ? (
            <PropertySchemaPick condition={condition} facts={facts} onChange={onChange} />
          ) : (
            <span className="nt-fb-block__typelabel" title={FAMILY_LABELS[family]}>
              {FAMILY_LABELS[family]}
            </span>
          )}
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
    case "linkedToQuery":
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

/**
 * The property family's row-identity slot: the schema
 * dropdown rides the TYPE column so the row reads [Property ▾] [Operator ▾]
 * [Value] — the field → operator → value register (Notion/Odoo). Picking a
 * different property resets the value (it was typed for the old type) and
 * normalizes the condition back to the plain property shape.
 */
function PropertySchemaPick({
  condition,
  facts,
  onChange,
}: {
  condition: Condition;
  facts: BuilderFacts;
  onChange: (condition: Condition) => void;
}) {
  const schemaId =
    condition.type === "property" || condition.type === "propertyBetween" || condition.type === "propertyWithin"
      ? condition.schemaId
      : "";
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
        if (value !== null) onChange({ type: "property", schemaId: value, op: "eq", value: "" });
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
