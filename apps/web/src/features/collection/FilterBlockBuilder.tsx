/**
 * FilterBlockBuilder — the NodeCollectionToolbar's structured panel: the
 * query-builder block UI over the v2 query AST.
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
 * (Links, Parent, Class, Tags) carry the v2 target-mode switch in its
 * three-mode form: Manual (picked nodes), Query (a nested query-block list
 * defining the target set — "links to a person node with age > 50"), or
 * Self (the page hosting the query — the member condition's `self` target,
 * resolving CompileOptions.selfNodeId at run time); the nested group
 * renders inside a card beneath the row (the v1 DynamicQuerySection
 * idiom; the nesting is infinite — a query-mode row inside a query
 * subgroup can go query again).
 * Groups nest as hairline-indented columns
 * with the Match ALL/ANY header toggle; the root level is not a group.
 * Every control bubbles an immutable update to the root group via onChange —
 * the parent (the NodeCollectionToolbar) owns the state, this module is chrome.
 *
 * The probe-riding leaves (the links/dynamic-target conditions, content
 * fts) evaluate through the runQueryAst query channel, never locally
 * (sectionViewResolve.ts leafNeedsProbe); the quick-search text is NOT part
 * of this tree — the NodeCollectionToolbar unshifts it into the composed group at prune
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
import { Button } from "../../components/ui/kit/Button.js";
import { ButtonWithPanel } from "../../components/ui/kit/ButtonWithPanel.js";
import { CodeTextarea } from "../../components/ui/kit/CodeTextarea.js";
import { Dropdown, type DropdownOption } from "../../components/ui/kit/Dropdown.js";
import { GridMenu } from "../../components/ui/kit/GridMenu.js";
import { Input } from "../../components/ui/kit/Input.js";
import { SelectionButton, type SelectionButtonOption } from "../../components/ui/kit/SelectionButton.js";
import { Card } from "../../components/ui/kit/Card.js";
import { useBuilderFacts, type BuilderFacts } from "./builderFacts.js";
import {
  createCondition,
  filterKindOptionsForConfig,
  filterQueryToGroup,
  type AddMenuEntry,
  type ConditionKind,
  type NodeCollectionToolbarConfig,
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
  /** The draft root group (component state at the NodeCollectionToolbar). */
  group: Group;
  onChange: (group: Group) => void;
  /** Which condition kinds the add menu offers (default: all). */
  config?: NodeCollectionToolbarConfig | undefined;
  /**
   * The hosting page's node id — the SELF target mode's anchor ("the page
   * this query sits on"). Absent at host-less surfaces (the hub filters):
   * the Self mode is not offered there (a self target would have no
   * honest reading — the compiler fails loud without one).
   */
  selfNodeId?: string | undefined;
  /**
   * Right-aligned content in the builder's foot row, beside the "Add
   * condition" menu (the NodeCollectionToolbar rides it with the "Save as tab" button —
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
  config?: NodeCollectionToolbarConfig | undefined;
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

export function FilterBlockBuilder({ client, group, onChange, config, selfNodeId, footExtra }: FilterBlockBuilderProps) {
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
          selfNodeId={selfNodeId}
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
  config?: NodeCollectionToolbarConfig | undefined;
  datalistId: string;
  /** The hosting page's id — the SELF target mode's anchor (absent = not offered). */
  selfNodeId?: string | undefined;
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

function GroupBlock({ group, onChange, onDelete, depth, bare = false, client, facts, config, datalistId, menuWidth, selfNodeId }: GroupBlockProps) {
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
                  selfNodeId={selfNodeId}
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
                  selfNodeId={selfNodeId}
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
                selfNodeId={selfNodeId}
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

function NotBlock({ not, onChange, onDelete, depth, client, facts, config, datalistId, menuWidth, selfNodeId }: NotBlockProps) {
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
            selfNodeId={selfNodeId}
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
            selfNodeId={selfNodeId}
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
  selfNodeId,
}: BlockRowProps) {
  const view = blockView(child)!;
  const { negated, condition } = view;
  const family = familyOf(condition);
  const label = FAMILY_LABELS[family];
  const canMoveUp = onMoveUp !== undefined && index > 0;
  const canMoveDown = onMoveDown !== undefined && index < totalSiblings - 1;
  const showReorder = onMoveUp !== undefined || onMoveDown !== undefined;
  /**
   * The node-target families' target mode — the three-way switch: Manual
   * (picked node(s)), Query (a nested query defining the target set), Self
   * (the page hosting the query, resolving at run time). v2 carries the mode
   * on the member condition's `target`; the set bits (exists / not-exists)
   * have no target and read as Manual until the switch re-materializes an
   * `in`.
   */
  const memberFamily =
    condition.type === "member" && family !== "type" && family !== "placement"
      ? condition.family
      : null;
  let queryRoot: Group | null = null;
  let mode: "manual" | "query" | "self" = "manual";
  if (condition.type === "member") {
    if (condition.op === "in" || condition.op === "not-in" || condition.op === "exact") {
      if (condition.target.mode === "query") {
        mode = "query";
        queryRoot = condition.target.root;
      } else if (condition.target.mode === "self") {
        mode = "self";
      }
    }
  }
  /** True when the row's target mode is Query (the nested card renders). */
  const dynamic = mode === "query";
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
        {(() => {
          // The boolean rows (Type/Placement) ride a single value selector —
          // an empty operator register renders NO operator column (the
          // ruling); every other family renders the dropdown.
          const operatorOpts = operatorOptions(family, condition, facts);
          if (operatorOpts.length === 0) return null;
          return (
            <div className="nt-fb-block__operator">
              <Dropdown
                size="sm"
                ariaLabel="Operator"
                options={operatorOpts.map((option) => ({ value: option.value, label: option.label }))}
                value={operatorOf(condition, negated)}
                onChange={(value) => {
                  if (value !== null) onChange(applyOperator(condition, value));
                }}
              />
            </div>
          );
        })()}
        <div className="nt-fb-block__value">
          <BlockValue
            condition={condition}
            onChange={(next) => onChange(negated ? { type: "not", child: next } : next)}
            client={client}
            facts={facts}
            datalistId={datalistId}
          />
        </div>
        {memberFamily !== null && (
          <SelectionButton
            size="sm"
            aria-label="Target mode"
            options={[
              { value: "manual", icon: "mdi mdi-pin-outline", label: "Manual — picked nodes" },
              { value: "query", icon: "mdi mdi-filter-variant", label: "Query — a nested query" },
              // The Self mode needs a hosting page to resolve against; a
              // row already IN Self mode keeps its option even at a
              // host-less surface (the mode button must show its value).
              ...(selfNodeId !== undefined || mode === "self"
                ? [{ value: "self", icon: "mdi mdi-crosshairs", label: "Self — the page this query sits on" }]
                : []),
            ]}
            value={mode}
            onChange={(nextMode) => {
              if (condition.type !== "member") return;
              const empty = { type: "group", logic: "and", children: [] } as Group;
              // The mode switch rebuilds ONLY the target — the operator (in /
              // not-in) survives the mode change verbatim. A set row (no
              // target) first re-materializes a membership op, preserving
              // its polarity (not-exists → not-in); the current ids carry
              // into Manual where the row had them.
              const carriedIds =
                (condition.op === "in" || condition.op === "not-in") &&
                condition.target.mode === "ids"
                  ? condition.target.ids
                  : [];
              const inOp =
                condition.op === "not-in" || condition.op === "not-exists" ? "not-in" : "in";
              const next: Condition =
                nextMode === "query"
                  ? { type: "member", family: condition.family, op: inOp, target: { mode: "query", root: empty } }
                  : nextMode === "self"
                    ? { type: "member", family: condition.family, op: inOp, target: { mode: "self" } }
                    : { type: "member", family: condition.family, op: inOp, target: { mode: "ids", ids: carriedIds } };
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
      {/* Query mode: the nested query rides beneath the row inside a kit
          Card (the one contained-subgroup surface); the nesting is infinite (a
          query row inside a query subgroup can go query again). */}
      {dynamic && queryRoot !== null && condition.type === "member" && (
        <div className="nt-fb-block__nested">
          {/* The `default` variant (surface fill + the outline-variant
              hairline): the `filled` variant is border-less and the subgroup
              blended into the panel — the boundary must read. */}
          <Card padding paddingSize="sm" variant="default" className="nt-fb-card">
            <GroupBlock
              group={queryRoot}
              onChange={(root) => {
                const target = { mode: "query" as const, root };
                onChange(
                  (negated
                    ? { type: "not", child: { ...condition, target } }
                    : { ...condition, target }) as Child,
                );
              }}
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
