/**
 * filterQuery — the transient filter layer's data.
 *
 * A filterable section renders a NodeCollectionToolbar whose state is a FilterQuery: the
 * quick-search text plus a DRAFT query-AST root group the structured panel's
 * block builder edits (`Group` from @notees/query, the one normative
 * v2 grammar — the builder is the query-builder block UI over the v2 AST).
 * The draft is allowed to carry half-typed rows (a class condition with no
 * class picked yet, a content condition with a blank value);
 * `filterQueryToGroup` prunes those into the schema-valid composed root the
 * structured evaluation consumes, returning null when nothing survives. The
 * quick-search text does NOT ride that root — it narrows the rows through
 * the ranked search before the group applies (one
 * ordering everywhere: the text facet's membership AND order come from
 * `client.search`, the same ranked ordering the global search uses, which
 * an AST condition cannot express).
 *
 * The offered subset is the full v2 wire grammar: the member families
 * (class/tags/links/referencePath/parent/child/childPath/page/parentPath/
 * root with their in/not-in/exists ops and ids/query/self target modes),
 * content (contains AND full-text), property, the nodeField wire predicates
 * (isClass/isEmbedded/coverAsset/bannerAsset/aliasedNode), and the date
 * family's created/edited windows. The sync-evaluable kinds ride
 * `createSectionViewMatcher`; the probe-path leaves (the links/referencePath
 * families, any member with a query/self target, content fts) ride one
 * membership probe per leaf through the runQueryAst channel inside
 * useSectionData — the same machinery the hosted custom views use (the
 * one-evaluation ruling).
 *
 * Application (components/useSectionData.ts): the quick text narrows the
 * section's resolved rows through the ranked search FIRST (membership AND
 * order), then the composed group filters the narrowed pool
 * POST-RESOLUTION and PRE-WINDOWING — windowing sees the filtered set; the
 * resolution cache is untouched (a query change re-derives from the cached
 * rows, it never re-runs the query); the eager count stays UNFILTERED (an
 * active filter shows "0 of N", the section never vanishes). The query is
 * component state — one instance per section view/tab, lost on reload,
 * nothing persisted.
 */

import type { Child, Condition, Group, MemberCondition, QueryAst, TargetRef } from "@notees/query";

/** The bar's state: quick-search text plus the builder's draft root group. */
export interface FilterQuery {
  /**
   * The quick-search text: ranked search semantics — the global search's
   * priority ordering over titles (exact substring > ordered terms >
   * partials > fuzzy rescue), NOT a raw substring.
   */
  text?: string | undefined;
  /** The structured panel's draft root group (the query-AST grammar). */
  group: Group;
}

/** The inactive query — the bar's resting state. */
export const EMPTY_FILTER_QUERY: FilterQuery = {
  group: { type: "group", logic: "and", children: [] },
};

/** The factory AST a new hosted tab starts from when the bar's draft is empty. */
export const FACTORY_QUERY_AST: QueryAst = {
  version: 2,
  scope: { type: "entire_workspace" },
  root: { type: "group", logic: "and", children: [] },
};

/**
 * The AST a new hosted tab starts from: the composed draft verbatim, falling back
 * to the factory AST when the draft is empty.
 */
export function draftOrFactoryAst(value: FilterQuery): QueryAst {
  const group = filterQueryToGroup(value);
  return group === null
    ? FACTORY_QUERY_AST
    : { version: 2, scope: { type: "entire_workspace" }, root: group };
}

/** True when the text is blank AND the draft group has no children. */
export function isFilterInactive(query: FilterQuery): boolean {
  return (query.text?.trim() ?? "") === "" && query.group.children.length === 0;
}

/**
 * The per-section facet configuration — `SectionSpec.filterable` and the
 * NodeCollectionToolbar's `config`. Every facet defaults on; `filterable: true` is the
 * full set, absent/false renders no bar at all. The facets gate the quick
 * text field and which condition KINDS the builder's add menu offers; the
 * other kinds (type/placement/content/wire fields/groups) are always
 * offered.
 */
export interface NodeCollectionToolbarConfig {
  text?: boolean | undefined;
  class?: boolean | undefined;
  properties?: boolean | undefined;
  dateRange?: boolean | undefined;
}

// --- the draft → composed group prune ---------------------------------------

/**
 * The member condition's prune: the set bits (exists / not-exists) are
 * always fully specified and survive; an ids target with an empty pick
 * drops (the half-typed row); a query target drops when its nested group
 * pruned to empty; the self target survives (the host resolves at run time).
 */
function pruneMember(child: MemberCondition): MemberCondition | null {
  // The op switch narrows the member union (TS discriminates the
  // multi-literal member ops reliably only through the switch form).
  switch (child.op) {
    case "exists":
    case "not-exists":
      // The set bits are always fully specified and survive.
      return child;
    case "exact":
      return child.target.ids[0] === "" ? null : child;
    default:
      if (child.target.mode === "ids") return child.target.ids.length === 0 ? null : child;
      if (child.target.mode === "self") return child;
      {
        const nested = pruneChild(child.target.root);
        return nested === null || (nested.type === "group" && nested.children.length === 0)
          ? null
          : { ...child, target: { ...child.target, root: nested as Group } };
      }
  }
}

/**
 * Prune one draft child into its composed form: half-typed conditions drop
 * (content with a blank value, a member with an empty ids pick, property
 * with an empty schemaId or a range missing a bound, date comparisons with
 * a blank timestamp), nested groups recurse (emptied ones drop), a not drops
 * when its child pruned away, and a member with a query target drops when
 * its nested group pruned to empty. Anything fully specified — the set
 * bits, the self target, the node-field predicates, date within — survives
 * verbatim.
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
    case "name":
      return child.op !== "exists" && (child.value ?? "").trim() === "" ? null : child;
    case "member":
      return pruneMember(child);
    case "property":
      if (child.schemaId === "") return null;
      if (child.op === "between") {
        return child.from === undefined || child.to === undefined ? null : child;
      }
      return child;
    case "date":
      if (child.op === "between") {
        return (child.from ?? "").trim() === "" || (child.to ?? "").trim() === "" ? null : child;
      }
      if (child.op === "within") return child;
      return (child.timestamp ?? "").trim() === "" ? null : child;
    default:
      // nodeField — always fully specified.
      return child;
  }
}

/**
 * The trimmed quick-search text ("" when the facet is blank) — the value
 * the ranked search path consumes; the structured draft never sees it.
 */
export function quickTextOf(query: FilterQuery): string {
  return query.text?.trim() ?? "";
}

/**
 * Compose the structured draft into the schema-valid root group evaluation
 * consumes, returning null when nothing survives (the hook treats null as
 * "no structured filter"). The quick-search text is deliberately absent:
 * it narrows the rows through the ranked search BEFORE this group applies
 * its membership and ordering are the search's, which
 * an AST condition cannot express.
 */
export function filterQueryToGroup(query: FilterQuery): Group | null {
  const children = query.group.children
    .map((child) => pruneChild(child))
    .filter((child): child is Child => child !== null);
  if (children.length === 0) return null;
  return { type: "group", logic: query.group.logic, children };
}

// --- the add-menu registry ---------------------------------------------------

/**
 * The block FAMILIES (the v2 add-menu register as single-word types — the
 * operator column carries the is/is-not/contains/etc variation). The
 * node-target families (Links, Parent, Class, Tags, …) bind a TARGET with
 * three modes: Manual (picked nodes), Query (a nested query defining the
 * target set), or Self (the page hosting the query) — the mode switch picks
 * between them. "Page" / "Parent path" / "Root" are the classed-CONTAINER
 * families: they test the class of the row's containing page / some strict
 * ancestor / the workspace-root ancestor — e.g. "blocks whose page is not
 * classed as Day" drops the journal-day groups from a backlinks section.
 */
export type ConditionKind =
  | "class"
  | "type"
  | "placement"
  | "content"
  | "property"
  | "tags"
  | "links"
  | "referencePath"
  | "parent"
  | "child"
  | "childPath"
  | "page"
  | "parentPath"
  | "root"
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
 * The add-menu register (the v2 FILTER_KIND_OPTIONS, 1:1 over the v2 AST —
 * single-word types, operators live in the block's operator column). Group
 * constructors come last, the established order.
 */
export const FILTER_KIND_OPTIONS: readonly FilterKindOption[] = [
  { value: "class", label: "Class", icon: "mdi mdi-tag-outline", description: "Filter by node class" },
  { value: "type", label: "Type", icon: "mdi mdi-shape-outline", description: "A class or not a class" },
  { value: "placement", label: "Structural role", icon: "mdi mdi-format-align-left", description: "Page (standalone) or Block (embedded in body)" },
  { value: "content", label: "Content", icon: "mdi mdi-text-box-outline", description: "Filter by text content" },
  { value: "property", label: "Property", icon: "mdi mdi-code-braces", description: "Filter by property value" },
  { value: "tags", label: "Tags", icon: "mdi mdi-tag-multiple-outline", description: "Filter by assigned tags (any page)" },
  { value: "links", label: "Links", icon: "mdi mdi-link-variant", description: "Nodes that link to a node" },
  { value: "referencePath", label: "Link path", icon: "mdi mdi-link-plus", description: "The node or its ancestors reference these nodes — or the node sits inside them" },
  { value: "parent", label: "Parent", icon: "mdi mdi-file-tree-outline", description: "The direct parent is any of these nodes" },
  { value: "child", label: "Child", icon: "mdi mdi-file-tree", description: "Contains any of these nodes as direct children" },
  { value: "childPath", label: "Child path", icon: "mdi mdi-arrow-decision-outline", description: "Contains any of these nodes anywhere down their tree" },
  { value: "page", label: "Page", icon: "mdi mdi-page-layout-body", description: "The containing page is any of these nodes" },
  { value: "parentPath", label: "Parent path", icon: "mdi mdi-source-branch", description: "An ancestor anywhere up the parent chain is any of these nodes" },
  { value: "root", label: "Root", icon: "mdi mdi-arrow-collapse-up", description: "The top-level parent (workspace-root child) is any of these nodes" },
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
export function filterKindOptionsForConfig(config?: NodeCollectionToolbarConfig): readonly FilterKindOption[] {
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
      // The default CLASS row rides the MULTI-VALUE membership register:
      // "Class contains Day, Week" — closure-aware ANY-of over the picked
      // list — is the intent nearly always; the exact single-pill reading
      // ("is") is the deliberate narrow operator. Both bind the v2 wire op
      // "in" over an ids target.
      return { type: "member", family: "class", op: "in", target: { mode: "ids", ids: [] } };
    case "type":
      return { type: "nodeField", field: "isClass", op: "eq", value: "true" };
    case "placement":
      return { type: "nodeField", field: "isEmbedded", op: "eq", value: "false" };
    case "content":
      return { type: "content", op: "contains", value: "" };
    case "property":
      return { type: "property", schemaId: "", op: "eq", value: "" };
    case "tags":
    case "links":
    case "referencePath":
    case "parent":
    case "child":
    case "childPath":
    case "page":
    case "parentPath":
    case "root":
      // The node-target families bind the LIST by default: "Tags is
      // Urgent, Later", "Links is Alpha, Beta" — ANY-of membership over the
      // picked ids (the Manual target mode; the mode switch re-targets to a
      // nested query or the hosting page).
      return { type: "member", family: kind, op: "in", target: { mode: "ids", ids: [] } };
    case "cover":
      return { type: "nodeField", field: "coverAsset", op: "exists" };
    case "banner":
      return { type: "nodeField", field: "bannerAsset", op: "exists" };
    case "alias":
      return { type: "nodeField", field: "aliasedNode", op: "exists" };
    case "created":
      return { type: "date", field: "created", op: "after", timestamp: "" };
    case "edited":
      return { type: "date", field: "updated", op: "after", timestamp: "" };
  }
}
