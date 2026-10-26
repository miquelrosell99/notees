/**
 * FilterBlockBuilder — the NodeCollectionBar's structured panel: the v1
 * query-builder block UI ported over the v2 query AST.
 * One feature file pair with FilterBlockBuilder.css (the NodeCollectionTabs
 * precedent), composed from kit primitives only. The condition model
 * (families, operator options, the operator-application morphs) lives in
 * filterBlockModel.ts and the value-column pickers in
 * filterBlockValueControls.tsx (Stage D monolith split, 2026-10-19); this
 * file keeps the builder composition (the root, GroupBlock, NotBlock, and
 * the condition row).
 *
 * The chrome is FLAT, matching the app's list surfaces — no containing
 * cards on the groups themselves (card-in-card
 * read as a modal): the builder rides a HEAD row (both switches on ONE
 * line — the root Match ALL/ANY logic toggle left, the blocks ⇄ raw AST
 * toggle right), a bare column of condition rows,
 * and a FOOT row ("Add condition" left, the caller's extras right — today
 * the "Save as tab" escape; the count moved to the hosted tab bar's
 * active-tab badge); nested groups indent under a left hairline with their own
 * header/footer, and condition rows are list rows — transparent with a
 * hover fill. The two card surfaces are the transient add-menu popover and
 * the DYNAMIC mode's nested-query subgroup (the
 * one contained subgroup reads as a card, `nt-fb-card`).
 *
 * The registers are the v1 ones (the 1:1 block model;
 * the row IDENTITY is READONLY once added — the Notion/
 * Odoo field → operator → value register: no row morphing, a kind change is
 * delete + re-add) — each block is a row of COLUMNS: a TYPE slot (a static
 * label naming the family — except the PROPERTY family, where the schema
 * dropdown so the row reads [Property ▾] [Operator ▾]
 * [Value]), an OPERATOR dropdown whose options vary by family — the class
 * family carries the multi-value set: is / is not
 * (EXACT single-pill equality), contains / does not contain (closure ANY-of
 * over the picked list — the collapsed "one of"), is set / is not set
 * (emptiness); the content/property/date families carry their own
 * variation (full-text / ordering / after / before — the negatives are
 * not-wrap sugar, the booleans flip their bit), then the VALUE
 * control (typed per family — the property-table register: numeric keyboard,
 * placeholder datalist, anchored node picker). The selection columns ride
 * the kit Dropdown register and the text values the kit Input (the boxed
 * field pairing with SelectTrigger: the raw native
 * <select>s rendered the browser's chrome, unaligned with the token
 * interface); the node-target families
 * (Links, Parent, Class, Tags) carry the v1 MODE SWITCH: static (picked
 * nodes) or dynamic (a nested query-block list defining the target set —
 * "links to a person node with age > 50"), the nested group rendering
 * inside a card beneath the row (the v1 DynamicQuerySection; the nesting is
 * infinite — a dynamic row inside a dynamic subgroup can go dynamic again).
 * Groups nest as hairline-indented columns
 * with the Match ALL/ANY header toggle; the root level is not a group.
 * Every control bubbles an immutable update to the root group via onChange —
 * the parent (the NodeCollectionBar) owns the state, this module is chrome.
 *
 * The probe-riding leaves (the links/dynamic-target conditions, content
 * fts) evaluate through the runQueryAst query channel, never locally
 * (sectionViewResolve.ts leafNeedsProbe); the quick-search text is NOT part
 * of this tree — the NodeCollectionBar unshifts it into the composed group at prune
 * time.
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";

import {
  QUERY_PLACEHOLDERS,
  groupSchema,
  type Child,
  type Condition,
  type Group,
  type Not,
} from "@notees/query";

import type { AnyClient } from "./index.js";

import { Icon } from "../../ui/Icon.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { ButtonWithPanel } from "../../components/ui/fleet/ButtonWithPanel.js";
import { CodeTextarea } from "../../components/ui/fleet/CodeTextarea.js";
import { Dropdown, type DropdownOption } from "../../components/ui/fleet/Dropdown.js";
import { GridMenu } from "../../components/ui/fleet/GridMenu.js";
import { Input } from "../../components/ui/fleet/Input.js";
import { SelectionButton, type SelectionButtonOption } from "../../components/ui/fleet/SelectionButton.js";
import { Card } from "../../components/ui/fleet/Card.js";
import { useBuilderFacts, type BuilderFacts } from "./builderFacts.js";
import {
  createCondition,
  filterKindOptionsForConfig,
  filterQueryToGroup,
  type AddMenuEntry,
  type NodeCollectionBarConfig,
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

/**
 * The Match ALL/ANY logic options — the BORDERED button switcher (the fleet
 * SelectionButton, mode/view switching rides it;
 * the AND/OR register settled on the ORIGINAL overlapping-circles v1 icons
 * — set-all (AND) / set-center (OR); gate symbols and bold text were both
 * trialed and rejected, the owner came back to these). `label` stays the
 * accessible name; shared by the root head row AND every nested group
 * header.
 */
const LOGIC_OPTIONS: SelectionButtonOption[] = [
  { value: "and", icon: "mdi-set-all", label: "Match ALL conditions" },
  { value: "or", icon: "mdi-set-center", label: "Match ANY condition" },
];

export interface FilterBlockBuilderProps {
  client: AnyClient;
  /** The draft root group (component state at the NodeCollectionBar). */
  group: Group;
  onChange: (group: Group) => void;
  /** Which condition kinds the add menu offers (default: all). */
  config?: NodeCollectionBarConfig | undefined;
  /**
   * Right-aligned content in the builder's foot row, beside the "Add
   * condition" menu (the NodeCollectionBar rides it with the "Save as tab" button —
   * the count line moved to the hosted tab bar's active-tab badge).
   */
  footExtra?: ReactNode | undefined;
}

/**
 * The add-menu register shared by every group level (one small component, used by the nested group footers AND
 * the root builder's foot row). The popup spans `width` (the builder or
 * card container's) with auto columns filling it.
 */
function AddConditionMenu({
  config,
  width,
  onAdd,
}: {
  config?: NodeCollectionBarConfig | undefined;
  width: number;
  onAdd: (entry: AddMenuEntry) => void;
}) {
  /** The add menu's open state — drives the trigger chevron (the dropdown register). */
  const [addOpen, setAddOpen] = useState(false);
  const menuItems = filterKindOptionsForConfig(config).map((entry) => ({
    id: entry.value,
    icon: entry.icon,
    label: entry.label,
    description: entry.description,
  }));
  return (
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
      panelWidth={width}
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
            onAdd(id as AddMenuEntry);
            closePanel();
          }}
        />
      )}
    </ButtonWithPanel>
  );
}

/**
 * Append one add-menu entry to a group — the group constructors insert a
 * group with the mode pre-set ("All of"/"Any of"), NOT wraps a fresh empty
 * group, the condition kinds append a half-typed default (createCondition).
 * Shared by the root builder's foot row and the nested group footers.
 */
function withAddedEntry(group: Group, entry: AddMenuEntry): Group {
  if (entry === "group-and" || entry === "group-or") {
    return {
      ...group,
      children: [
        ...group.children,
        { type: "group", logic: entry === "group-and" ? "and" : "or", children: [] },
      ],
    };
  }
  if (entry === "not") {
    return {
      ...group,
      children: [
        ...group.children,
        { type: "not", child: { type: "group", logic: "and", children: [] } },
      ],
    };
  }
  return { ...group, children: [...group.children, createCondition(entry)] };
}

export function FilterBlockBuilder({ client, group, onChange, config, footExtra }: FilterBlockBuilderProps) {
  const facts = useBuilderFacts(client);
  /** The placeholder datalist, rendered once, useId-scoped. */
  const datalistId = useId();
  /**
   * The blocks ⇄ raw AST toggle: the raw mode is
   * the EXCHANGE format — copy a query out, paste one in (another section,
   * node, tab). It rides the COMPOSED group: switching to raw serializes
   * the pruned draft (`filterQueryToGroup`), so half-typed rows drop; Apply
   * validates against the wire `groupSchema` and replaces the whole draft.
   */
  const [view, setView] = useState<"blocks" | "raw">("blocks");
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);
  /** The raw editor's label association (the kit CodeTextarea's htmlFor). */
  const rawId = useId();
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

  const toRawText = (): string =>
    JSON.stringify(
      filterQueryToGroup({ text: "", group }) ?? { type: "group", logic: "and", children: [] },
      null,
      2,
    );

  const applyRaw = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      setRawError(`Invalid JSON — ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const result = groupSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0]!;
      const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      setRawError(`Not a query group — ${where}${issue.message}`);
      return;
    }
    onChange(result.data);
    // Feedback the apply landed: the normalized JSON re-serializes into the
    // textarea (the draft it came from may have been formatted differently).
    setRawText(JSON.stringify(result.data, null, 2));
    setRawError(null);
  };

  return (
    <div className="nt-fb" ref={rootRef}>
      <datalist id={datalistId}>
        {QUERY_PLACEHOLDERS.map((placeholder) => (
          <option key={placeholder} value={placeholder} />
        ))}
      </datalist>
      {/* The head row: BOTH switches on ONE row —
          the root Match ALL/ANY logic toggle (left, moved out of the root
          group's header) and the blocks ⇄ raw AST toggle (right, replacing
          the old floating viewbar row). */}
      <div className="nt-fb__head">
        <SelectionButton
          options={LOGIC_OPTIONS}
          value={group.logic}
          onChange={(logic) => onChange({ ...group, logic: logic as Group["logic"] })}
          size="sm"
          aria-label="Group logic"
        />
        <span className="nt-fb__head-spacer" />
        <SelectionButton
          size="sm"
          aria-label="Builder view"
          options={[
            { value: "blocks", icon: "mdi mdi-toy-brick-outline", label: "Blocks" },
            { value: "raw", icon: "mdi mdi-code-braces", label: "Raw AST" },
          ]}
          value={view}
          onChange={(next) => {
            if (next === "raw") {
              setRawText(toRawText());
              setRawError(null);
            }
            setView(next as "blocks" | "raw");
          }}
        />
      </div>
      {view === "raw" ? (
        <div className="nt-fb__raw">
          <CodeTextarea
            id={rawId}
            value={rawText}
            onChange={(next) => {
              setRawText(next);
              setRawError(null);
            }}
            // The visible label is hidden by the raw-mode CSS — the accessible name stays via the label/htmlFor.
            label="Query AST (JSON)"
            error={rawError !== null}
            spellCheck={false}
          />
          <div className="nt-fb__raw-actions">
            <Button type="button" variant="outline" size="sm" onClick={applyRaw}>
              Apply
            </Button>
          </div>
          {rawError !== null && (
            <p className="nt-error" role="alert">
              {rawError}
            </p>
          )}
        </div>
      ) : (
        <GroupBlock
          group={group}
          onChange={onChange}
          depth={0}
          bare
          client={client}
          facts={facts}
          config={config}
          datalistId={datalistId}
          menuWidth={menuWidth}
        />
      )}
      {/* The foot row: the "Add condition" menu (left — the ONE group
          constructor at the root too) and the caller's right-aligned
          cluster (today the "Save as tab" button — the count moved to the
          hosted tab bar's active-tab badge). In raw mode there are
          no blocks to add, but the caller's content still rides. */}
      <div className="nt-fb__foot">
        {view === "blocks" && (
          <AddConditionMenu
            config={config}
            width={menuWidth}
            onAdd={(entry) => onChange(withAddedEntry(group, entry))}
          />
        )}
        <span className="nt-fb__foot-spacer" />
        {footExtra}
      </div>
    </div>
  );
}

// --- the group card ------------------------------------------------------------

interface BlockContext {
  client: AnyClient;
  facts: BuilderFacts;
  config?: NodeCollectionBarConfig | undefined;
  datalistId: string;
}

interface GroupBlockProps extends BlockContext {
  group: Group;
  onChange: (group: Group) => void;
  /** The parent's delete — absent at the root. */
  onDelete?: () => void;
  depth: number;
  /**
   * The root builder renders the head (logic toggle) and foot (Add
   * condition) itself (both switches share the
   * head row, the foot carries the count line) — the root GroupBlock rides
   * BARE: no header, no footer. Nested groups and NOT-wrapped groups keep
   * theirs.
   */
  bare?: boolean;
  /**
   * The add menu's width — the builder container's at the root. Nested
   * groups arrive with 0 and measure their own container instead (the
   * dynamic subgroup rides the kit Card — a 0-width menu popup renders
   * invisible, the card's Add condition must read at the card's width).
   */
  menuWidth: number;
}

function GroupBlock({ group, onChange, onDelete, depth, bare = false, client, facts, config, datalistId, menuWidth }: GroupBlockProps) {
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
  const addEntry = (entry: AddMenuEntry): void => onChange(withAddedEntry(group, entry));

  // The root level is NOT a group — no count label, no
  // empty placeholder there; those read on nested groups only. The root
  // level is also BARE: its header and footer
  // live on the builder's head/foot rows instead.
  const nested = depth > 0;
  /**
   * Nested groups measure their own container for the add menu (the root
   * arrives with the builder container's width measured upstream). A
   * 0-width popup renders invisible — the dynamic subgroup's Add condition
   * would open a menu nobody can see or hit.
   */
  const groupRef = useRef<HTMLDivElement>(null);
  const [ownWidth, setOwnWidth] = useState(0);
  useEffect(() => {
    if (!nested) return;
    const el = groupRef.current;
    if (el === null) return;
    const measure = () => setOwnWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [nested]);
  const addMenuWidth = menuWidth > 0 ? menuWidth : Math.max(280, ownWidth);

  return (
    <div
      ref={groupRef}
      className={`nt-fb-group${nested ? " nt-fb-group--nested" : ""}`}
      style={{ "--nt-fb-depth": depth } as CSSProperties}
    >
      {!bare && (
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
      )}
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
      {!bare && (
        <div className="nt-fb-group__footer">
          {/* The add menu is the ONE group constructor too ("All of"/"Any of"
              insert a group with the mode pre-set) — no separate Add group
              button. */}
          <AddConditionMenu config={config} width={addMenuWidth} onAdd={addEntry} />
        </div>
      )}
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
   * links / parent / page / parent path / root / class / tags alike). */
  const dynamic =
    condition.type === "linkedToQuery" ||
    condition.type === "descendantOfQuery" ||
    condition.type === "pageOfQuery" ||
    condition.type === "ancestorInQuery" ||
    condition.type === "rootInQuery" ||
    condition.type === "parentOfQuery" ||
    condition.type === "childOfQuery" ||
    condition.type === "referencePathOfQuery" ||
    condition.type === "classAnyQuery" ||
    condition.type === "tagAnyQuery";
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
          family === "class" ||
          family === "tags" ||
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
              const staticFor = (type: string): Condition => {
                if (type === "linkedTo" || type === "descendantOf") {
                  return { type, nodeId: "" } as Condition;
                }
                if (type === "classAny") return { type, classIds: [] } as Condition;
                if (type === "tagAny") return { type, tagIds: [] } as Condition;
                return { type, nodeIds: [] } as Condition;
              };
              const dynamicType =
                family === "class"
                  ? "classAnyQuery"
                  : family === "tags"
                    ? "tagAnyQuery"
                    : family === "links"
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
                family === "class"
                  ? "classAny"
                  : family === "tags"
                    ? "tagAny"
                    : family === "links"
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
      {/* Dynamic mode: the nested query rides beneath the row inside a kit
          Card (the one contained-subgroup surface); the nesting is infinite (a dynamic row inside a
          dynamic subgroup can go dynamic again). */}
      {dynamic && (
        <div className="nt-fb-block__nested">
          {/* The `default` variant (surface fill + the outline-variant
              hairline): the `filled` variant is border-less and the subgroup
              blended into the panel — the boundary must read. */}
          <Card padding paddingSize="sm" variant="default" className="nt-fb-card">
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
          </Card>
        </div>
      )}
    </div>
  );
}
