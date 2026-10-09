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
 * The offered subset is the full wire grammar: class, isClass,
 * presentAsMain, content (contains AND full-text), property, linkedTo
 * ("links to"), descendantOf ("parent is — anywhere up the parents tree",
 * owner 2026-10-09), createdAfter/createdBefore, and the three wire-field
 * exists predicates (coverAsset/bannerAsset/aliasedNode). The sync-
 * evaluable kinds ride `createSectionViewMatcher`; the two probe-path
 * leaves (linkedTo, content fts) ride one membership probe per leaf through
 * the runQueryAst channel inside useSectionData — the same machinery the
 * hosted custom views use (the one-evaluation ruling).
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
 * (content with a blank value, class with an empty classId, property with
 * an empty schemaId, created/updated with a blank timestamp, static
 * link/parent with no node picked), nested groups recurse (emptied ones
 * drop), a not drops when its child pruned away, and the DYNAMIC
 * link/parent sets drop when their nested group pruned to empty. Anything
 * fully specified — isClass, presentAsMain, the wire-field predicates —
 * survives verbatim.
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
    case "updatedAfter":
    case "updatedBefore":
      return child.timestamp.trim() === "" ? null : child;
    case "linkedTo":
    case "descendantOf":
      return child.nodeId === "" ? null : child;
    case "linkedToQuery":
    case "descendantOfQuery": {
      const nested = pruneChild(child.root);
      return nested === null || (nested.type === "group" && nested.children.length === 0)
        ? null
        : { ...child, root: nested as Group };
    }
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

/**
 * The block FAMILIES (the v1 FILTER_TYPE_OPTIONS as single-word types — the
 * operator column carries the is/is-not/contains/etc variation). "Links"
 * and "Parent" are the node-target families: static (a picked node) or
 * dynamic (a nested query defining the target set), the mode switch
 * toggling between them.
 */
export type ConditionKind =
  | "class"
  | "type"
  | "placement"
  | "content"
  | "property"
  | "links"
  | "parent"
  | "cover"
  | "banner"
  | "alias"
  | "created"
  | "edited";

/** One add-menu entry — a condition family or a group/not constructor. */
export type AddMenuEntry = ConditionKind | "group-and" | "group-or" | "not";

export interface FilterKindOption {
  value: AddMenuEntry;
  label: string;
  icon: string;
  description: string;
}

/**
 * The add-menu register (the v1 FILTER_TYPE_OPTIONS, 1:1 over the v2 AST —
 * owner 2026-10-09: single-word types, operators live in the block's
 * operator column). Group constructors come last, v1 order.
 */
export const FILTER_KIND_OPTIONS: readonly FilterKindOption[] = [
  { value: "class", label: "Class", icon: "mdi mdi-tag-outline", description: "Filter by node class" },
  { value: "type", label: "Type", icon: "mdi mdi-shape-outline", description: "A class or not a class" },
  { value: "placement", label: "Placement", icon: "mdi mdi-format-align-left", description: "Main children or inline body" },
  { value: "content", label: "Content", icon: "mdi mdi-text-box-outline", description: "Filter by text content" },
  { value: "property", label: "Property", icon: "mdi mdi-code-braces", description: "Filter by property value" },
  { value: "links", label: "Links", icon: "mdi mdi-link-variant", description: "Nodes that link to a node or a nested query" },
  { value: "parent", label: "Parent", icon: "mdi mdi-file-tree-outline", description: "Nodes inside a node's parents tree, or a nested query's" },
  { value: "cover", label: "Cover", icon: "mdi mdi-image-outline", description: "Cover is set or not" },
  { value: "banner", label: "Banner", icon: "mdi mdi-page-layout-header", description: "Banner is set or not" },
  { value: "alias", label: "Alias", icon: "mdi mdi-repeat-variant", description: "Alias of a main page, set or not" },
  { value: "created", label: "Created", icon: "mdi mdi-calendar-arrow-right", description: "Created after / before a date" },
  { value: "edited", label: "Edited", icon: "mdi mdi-calendar-edit", description: "Edited after / before a date" },
  { value: "group-and", label: "All of (AND)", icon: "mdi mdi-set-all", description: "Match all nested conditions" },
  { value: "group-or", label: "Any of (OR)", icon: "mdi mdi-set-center", description: "Match any nested condition" },
  { value: "not", label: "Exclude (NOT)", description: "Exclude matching nodes", icon: "mdi mdi-cancel" },
];

/** The add-menu entries a config offers — the gated kinds plus the groups. */
export function filterKindOptionsForConfig(config?: FilterBarConfig): readonly FilterKindOption[] {
  const showClass = config?.class ?? true;
  const showProperties = config?.properties ?? true;
  const showDateRange = config?.dateRange ?? true;
  return FILTER_KIND_OPTIONS.filter((option) => {
    if (option.value === "class") return showClass;
    if (option.value === "property") return showProperties;
    if (option.value === "created" || option.value === "edited") return !showDateRange ? false : true;
    return true;
  });
}

/** A fresh, half-typed condition per family — the block the menu appends. */
export function createCondition(kind: ConditionKind): Condition {
  switch (kind) {
    case "class":
      return { type: "class", classId: "" };
    case "type":
      return { type: "isClass", isClass: true };
    case "placement":
      return { type: "presentAsMain", presentAsMain: true };
    case "content":
      return { type: "content", op: "contains", value: "" };
    case "property":
      return { type: "property", schemaId: "", op: "eq", value: "" };
    case "links":
      return { type: "linkedTo", nodeId: "" };
    case "parent":
      return { type: "descendantOf", nodeId: "" };
    case "cover":
      return { type: "coverAsset", op: "exists" };
    case "banner":
      return { type: "bannerAsset", op: "exists" };
    case "alias":
      return { type: "aliasedNode", op: "exists" };
    case "created":
      return { type: "createdAfter", timestamp: "" };
    case "edited":
      return { type: "updatedAfter", timestamp: "" };
  }
}
