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
 * The registers are the v1 ones — a root group card whose header carries the
 * Match ALL/ANY logic toggle (kit SelectionButton), a "N conditions" label
 * and (for nested groups) a delete; a children list rendering each child as
 * a condition row, a nested group card, or a NOT wrapper; a footer with the
 * add menu (kit ButtonWithPanel — click-outside/Escape/arrow-nav ride the
 * primitive) and an "Add group" button whose new group inherits the parent's
 * logic (the v1 addNestedGroup semantics). Condition rows carry the reorder
 * chevrons and the delete (the v1 FilterBlockActions), and every control
 * bubbles an immutable update to the root group via onChange — the parent
 * (the FilterBar) owns the state, this module is chrome.
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

/** Neutral per-kind icons (the v1 register minus the per-type rainbow). */
const KIND_ICONS: Record<Condition["type"], string> = {
  class: "mdi mdi-tag-outline",
  isClass: "mdi mdi-shape-outline",
  presentAsMain: "mdi mdi-format-align-left",
  content: "mdi mdi-text-box-outline",
  property: "mdi mdi-code-braces",
  createdAfter: "mdi mdi-calendar-arrow-right",
  createdBefore: "mdi mdi-calendar-arrow-left",
  coverAsset: "mdi mdi-image-outline",
  bannerAsset: "mdi mdi-page-layout-header",
  aliasedNode: "mdi mdi-repeat-variant",
  linkedTo: "mdi mdi-link-variant",
  descendantOf: "mdi mdi-file-tree-outline",
};

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
            if (child.type === "not") {
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
              <ConditionRow
                key={index}
                condition={child}
                onChange={(updated) => updateChild(index, updated)}
                onDelete={() => deleteChild(index)}
                onMoveUp={() => moveChild(index, -1)}
                onMoveDown={() => moveChild(index, 1)}
                index={index}
                totalSiblings={group.children.length}
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
              <Icon path="mdi mdi-plus" size={0.8} />
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
  const patch = (child: Condition | Group): void => onChange({ ...not, child });
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
          <ConditionRow
            condition={not.child}
            onChange={patch}
            onDelete={onDelete}
            index={0}
            totalSiblings={1}
            client={client}
            facts={facts}
            datalistId={datalistId}
          />
        )}
      </div>
    </div>
  );
}

// --- the condition row -----------------------------------------------------------

interface ConditionRowProps extends BlockContext {
  condition: Condition;
  onChange: (condition: Condition) => void;
  onDelete: () => void;
  /** The reorder chevrons — absent at the ends (and for a NOT's single child). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  index: number;
  totalSiblings: number;
}

function ConditionRow({
  condition,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  index,
  totalSiblings,
  client,
  facts,
  datalistId,
}: ConditionRowProps) {
  const label = CONDITION_LABELS[condition.type];
  const canMoveUp = onMoveUp !== undefined && index > 0;
  const canMoveDown = onMoveDown !== undefined && index < totalSiblings - 1;
  const showReorder = onMoveUp !== undefined || onMoveDown !== undefined;
  return (
    <div className="nt-fb-condition">
      <Icon path={KIND_ICONS[condition.type]} size={0.75} className="nt-fb-condition__icon" />
      <span className="nt-fb-condition__label">{label}</span>
      <ConditionBody condition={condition} onChange={onChange} client={client} facts={facts} datalistId={datalistId} />
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
  );
}

const CONDITION_LABELS: Record<Condition["type"], string> = {
  class: "Class",
  isClass: "Type",
  presentAsMain: "Placement",
  content: "Content",
  property: "Property",
  createdAfter: "Created",
  createdBefore: "Created",
  coverAsset: "Cover",
  bannerAsset: "Banner",
  aliasedNode: "Alias",
  linkedTo: "Links to",
  descendantOf: "Parent is",
};

function ConditionBody({
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
        <>
          <span className="nt-fb-condition__word">is</span>
          <select
            aria-label="Type"
            value={String(condition.isClass)}
            onChange={(event) => onChange({ ...condition, isClass: event.target.value === "true" })}
          >
            <option value="true">A class</option>
            <option value="false">Not a class</option>
          </select>
        </>
      );
    case "presentAsMain":
      return (
        <>
          <span className="nt-fb-condition__word">is</span>
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
        </>
      );
    case "content":
      return (
        <>
          <select
            aria-label="Content match"
            value={condition.op}
            onChange={(event) =>
              onChange({ ...condition, op: event.target.value as ContentOp })
            }
          >
            <option value="contains">contains</option>
            <option value="fts">full-text</option>
          </select>
          <input
            aria-label="Content"
            value={condition.value}
            onChange={(event) => onChange({ ...condition, value: event.target.value })}
          />
        </>
      );
    case "linkedTo":
      return (
        <>
          <span className="nt-fb-condition__word">to</span>
          <NodePickBody
            nodeId={condition.nodeId}
            placeholder="Pick a node…"
            client={client}
            onPick={(nodeId) => onChange({ ...condition, nodeId })}
          />
        </>
      );
    case "descendantOf":
      return (
        <>
          <span className="nt-fb-condition__word">is</span>
          <NodePickBody
            nodeId={condition.nodeId}
            placeholder="Pick a parent…"
            client={client}
            onPick={(nodeId) => onChange({ ...condition, nodeId })}
          />
        </>
      );
    case "property":
      return (
        <PropertyBody condition={condition} onChange={onChange} facts={facts} />
      );
    case "createdAfter":
    case "createdBefore":
      return (
        <>
          <span className="nt-fb-condition__word">
            {condition.type === "createdAfter" ? "after" : "before"}
          </span>
          <input
            aria-label={condition.type === "createdAfter" ? "Created after" : "Created before"}
            list={datalistId}
            placeholder="{today} or 2026-10-04"
            value={condition.timestamp}
            onChange={(event) => onChange({ ...condition, timestamp: event.target.value })}
          />
        </>
      );
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return <span className="nt-fb-condition__word">is set</span>;
    default:
      // Probe-path kinds are not buildable here (filterQuery.ts) — render
      // the honest fallback so a foreign AST never breaks the panel.
      return (
        <span className="nt-fb-condition__word">
            {(condition as { type: string }).type}
        </span>
      );
  }
}

function PropertyBody({
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
      <select
        aria-label="Operator"
        value={condition.op}
        onChange={(event) => onChange({ ...condition, op: event.target.value as PropertyOp })}
      >
        {PROPERTY_OP_LABELS.map(({ op, label }) => (
          <option key={op} value={op}>
            {label}
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

/** The node-target picker shared by the Links-to / Parent-is rows — a quiet
 * trigger naming the chosen node, opening the anchored NodeSelector. */
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
