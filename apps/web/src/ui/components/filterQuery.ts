/**
 * filterQuery — the transient filter layer's data (owner 2026-10-08).
 *
 * A filterable section renders a FilterBar whose state is a FilterQuery: the
 * quick-search text plus a DRAFT query-AST root group the structured panel's
 * block builder edits (`Group` from @notees/query, the one normative
 * grammar — the builder is the v1 query-builder block UI ported over the
 * v2 AST). The draft is allowed to carry half-typed rows (a class condition
 * with no class picked yet, a content condition with a blank value);
 * `filterQueryToGroup` prunes those into the schema-valid composed root the
 * evaluation consumes, returning null when nothing survives.
 *
 * The offered subset is everything that evaluates SYNCHRONOUSLY over the
 * materialized row (sectionViewResolve.ts — the one evaluation
 * implementation): class, isClass, presentAsMain, content contains,
 * property, createdAfter/createdBefore, and the three wire-field exists
 * predicates (coverAsset/bannerAsset/aliasedNode). `linkedTo` and content
 * `fts` are deliberately NOT offered — they are probe-path leaves needing
 * the async runQueryAst channel, which the transient layer (apply on every
 * keystroke, derived per render) must not ride.
 *
 * Application (components/useSectionData.ts): the composed group filters the
 * section's resolved rows POST-RESOLUTION and PRE-WINDOWING — windowing sees
 * the filtered set; the resolution cache is untouched (a query change
 * re-derives from the cached rows, it never re-runs the query); the eager
 * count stays UNFILTERED (an active filter shows "0 of N", the section never
 * vanishes). The query is component state — one instance per section
 * view/tab, lost on reload, nothing persisted.
 */

import type { Child, Condition, Group } from "@notees/query";

/** The bar's state: quick-search text plus the builder's draft root group. */
export interface FilterQuery {
  /** Case-insensitive substring over the row's title. */
  text?: string | undefined;
  /** The structured panel's draft root group (the query-AST grammar). */
  group: Group;
}

/** The inactive query — the bar's resting state. */
export const EMPTY_FILTER_QUERY: FilterQuery = {
  group: { type: "group", logic: "and", children: [] },
};

/** True when the text is blank AND the draft group has no children. */
export function isFilterInactive(query: FilterQuery): boolean {
  return (query.text?.trim() ?? "") === "" && query.group.children.length === 0;
}

/**
 * The per-section facet configuration — `SectionSpec.filterable` and the
 * FilterBar's `config`. Every facet defaults on; `filterable: true` is the
 * full set, absent/false renders no bar at all. The facets gate the quick
 * text field and which condition KINDS the builder's add menu offers; the
 * other kinds (type/placement/content/wire fields/groups) are always
 * offered.
 */
export interface FilterBarConfig {
  text?: boolean | undefined;
  class?: boolean | undefined;
  properties?: boolean | undefined;
  dateRange?: boolean | undefined;
}

// --- the draft → composed group prune ---------------------------------------

/**
 * Prune one draft child into its composed form: half-typed conditions drop
 * (content with a blank value, class with an empty classId, property with an
 * empty schemaId, createdAfter/Before with a blank timestamp), nested groups
 * recurse (emptied ones drop), a not drops when its child pruned away.
 * Anything fully specified — isClass, presentAsMain, the wire-field
 * predicates — survives verbatim.
 */
function pruneChild(child: Child): Child | null {
  if (child.type === "group") {
    const children = child.children
      .map((nested) => pruneChild(nested))
      .filter((nested): nested is Child => nested !== null);
    return children.length === 0 ? null : { ...child, children };
  }
  if (child.type === "not") {
    const pruned = pruneChild(child.child);
    return pruned === null ? null : { ...child, child: pruned as Condition | Group };
  }
  switch (child.type) {
    case "content":
      return child.value.trim() === "" ? null : child;
    case "class":
      return child.classId === "" ? null : child;
    case "property":
      return child.schemaId === "" ? null : child;
    case "createdAfter":
    case "createdBefore":
      return child.timestamp.trim() === "" ? null : child;
    default:
      return child;
  }
}

/**
 * Compose the bar's state into the schema-valid root group evaluation
 * consumes: the draft pruned, the trimmed quick-search text unshifted as a
 * content-contains condition. Returns null when nothing survives (the hook
 * treats null as "no filter").
 */
export function filterQueryToGroup(query: FilterQuery): Group | null {
  const children = query.group.children
    .map((child) => pruneChild(child))
    .filter((child): child is Child => child !== null);
  const text = query.text?.trim() ?? "";
  if (text !== "") {
    children.unshift({ type: "content", op: "contains", value: text });
  }
  if (children.length === 0) return null;
  return { type: "group", logic: query.group.logic, children };
}

// --- the add-menu registry ---------------------------------------------------

/** The condition kinds the builder offers — the sync-evaluable subset. */
export type ConditionKind =
  | "class"
  | "isClass"
  | "presentAsMain"
  | "content"
  | "property"
  | "createdAfter"
  | "createdBefore"
  | "coverAsset"
  | "bannerAsset"
  | "aliasedNode";

/** One add-menu entry — a condition kind or a group/not constructor. */
export type AddMenuEntry = ConditionKind | "group-and" | "group-or" | "not";

export interface FilterKindOption {
  value: AddMenuEntry;
  label: string;
  icon: string;
  description: string;
}

/**
 * The add-menu register (the v1 FILTER_TYPE_OPTIONS adapted to the v2 AST
 * names). Group constructors come last, v1 order.
 */
export const FILTER_KIND_OPTIONS: readonly FilterKindOption[] = [
  { value: "class", label: "Class", icon: "mdi mdi-tag-outline", description: "Filter by node class" },
  { value: "isClass", label: "Type", icon: "mdi mdi-shape-outline", description: "A class or not a class" },
  { value: "presentAsMain", label: "Placement", icon: "mdi mdi-format-align-left", description: "Main children or inline body" },
  { value: "content", label: "Content", icon: "mdi mdi-text-box-outline", description: "Filter by text content" },
  { value: "property", label: "Property", icon: "mdi mdi-code-braces", description: "Filter by property value" },
  { value: "createdAfter", label: "Created after", icon: "mdi mdi-calendar-arrow-right", description: "Created on or after a date" },
  { value: "createdBefore", label: "Created before", icon: "mdi mdi-calendar-arrow-left", description: "Created on or before a date" },
  { value: "coverAsset", label: "Has cover", icon: "mdi mdi-image-outline", description: "Cover is set" },
  { value: "bannerAsset", label: "Has banner", icon: "mdi mdi-page-layout-header", description: "Banner is set" },
  { value: "aliasedNode", label: "Is alias", icon: "mdi mdi-repeat-variant", description: "Node is an alias of a main page" },
  { value: "group-and", label: "All of (AND)", icon: "mdi mdi-set-all", description: "Match all nested conditions" },
  { value: "group-or", label: "Any of (OR)", icon: "mdi mdi-set-center", description: "Match any nested condition" },
  { value: "not", label: "Exclude (NOT)", icon: "mdi mdi-cancel", description: "Exclude matching nodes" },
];

/** The add-menu entries a config offers — the gated kinds plus the groups. */
export function filterKindOptionsForConfig(config?: FilterBarConfig): readonly FilterKindOption[] {
  const showClass = config?.class ?? true;
  const showProperties = config?.properties ?? true;
  const showDateRange = config?.dateRange ?? true;
  return FILTER_KIND_OPTIONS.filter((option) => {
    if (option.value === "class") return showClass;
    if (option.value === "property") return showProperties;
    if (option.value === "createdAfter" || option.value === "createdBefore") return showDateRange;
    return true;
  });
}

/** A fresh, half-typed condition per kind — the row the menu appends. */
export function createCondition(kind: ConditionKind): Condition {
  switch (kind) {
    case "class":
      return { type: "class", classId: "" };
    case "isClass":
      return { type: "isClass", isClass: true };
    case "presentAsMain":
      return { type: "presentAsMain", presentAsMain: true };
    case "content":
      return { type: "content", op: "contains", value: "" };
    case "property":
      return { type: "property", schemaId: "", op: "eq", value: "" };
    case "createdAfter":
      return { type: "createdAfter", timestamp: "" };
    case "createdBefore":
      return { type: "createdBefore", timestamp: "" };
    case "coverAsset":
      return { type: "coverAsset", op: "exists" };
    case "bannerAsset":
      return { type: "bannerAsset", op: "exists" };
    case "aliasedNode":
      return { type: "aliasedNode", op: "exists" };
  }
}
