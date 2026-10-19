/**
 * FilterBlockBuilder — the FilterBar's structured panel: the v1
 * query-builder block UI ported over the v2 query AST.
 * One feature file pair with FilterBlockBuilder.css (the SectionViewTabs
 * precedent), composed from kit primitives only. The condition model
 * (families, operator options, the operator-application morphs) lives in
 * filterBlockModel.ts and the value-column pickers in
 * filterBlockValueControls.tsx (Stage D monolith split, 2026-10-19); this
 * file keeps the builder composition (the root, GroupBlock, NotBlock, and
 * the condition row).
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
  type Group,
  type Not,
} from "@notees/query";

import type { AnyClient } from "./index.js";

import { Icon } from "../../ui/Icon.js";
import { Button } from "../../ui/components/ui/Button.js";
import { ButtonWithPanel } from "../../ui/components/ui/ButtonWithPanel.js";
import { Dropdown, type DropdownOption } from "../../ui/components/ui/Dropdown.js";
import { GridMenu } from "../../ui/components/ui/GridMenu.js";
import { Input } from "../../ui/components/ui/Input.js";
import { SelectionButton, type SelectionButtonOption } from "../../ui/components/ui/SelectionButton.js";
import { useBuilderFacts, type BuilderFacts } from "./QueryBuilderFields.js";
import {
  createCondition,
  filterKindOptionsForConfig,
  type AddMenuEntry,
  type FilterBarConfig,
} from "./filterQuery.js";
import { BlockValue, PropertySchemaPick } from "./filterBlockValueControls.js";
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
