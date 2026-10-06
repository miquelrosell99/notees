/**
 * Query builder state <-> AST — the shared condition subset the builder UI
 * (QueryBlockView's popover, the FilterBuilderModal) represents honestly:
 *
 *  - a flat AND root of: class / isClass / presentAsMain / content-contains /
 *    createdAfter / createdBefore conditions;
 *  - at most ONE sort spec (field + direction);
 *  - at most ONE aggregation dimension + ONE measure.
 *
 * The read-back hazard: an AST using constructs OUTSIDE this
 * subset (or-roots, nested groups, NOT, property/linkedTo conditions, fts,
 * multi-sort, multi-dimension aggregations) used to load into the builder as
 * silent defaults, and a single Apply clobbered the rich AST. The guard here
 * (`builderUnsupportedConstructs`) names what the builder cannot represent so
 * the UI can render a read-only summary + an explicit "edit anyway" opt-in
 * before any lossy write.
 *
 * createdAfter/createdBefore read and write through the shared
 * state (values may be `{today}`-style placeholders — the compile-time
 * resolution lives in @notees/query's placeholders module), and a single
 * sort row is representable.
 */

import type { QueryAst, SortField, SortSpec } from "@notees/query";

export interface QueryBuilderState {
  /** Scope select value; "page" = the view root's subtree (only offered for document-chrome roots). */
  scope: "workspace" | "pages" | "page";
  /** Class filter (class condition); null/"" = any. */
  classId: string | null;
  /** isClass filter (Revision-11 boolean condition); "" = any. */
  isClass: "" | "true" | "false";
  /** presentAsMain filter (Revision-11 boolean condition); "" = any. */
  presentAsMain: "" | "true" | "false";
  /** content contains filter (trimmed on write); "" = none. */
  contains: string;
  /** createdAfter timestamp (ISO datetime or `{today}`-style placeholder); "" = none. */
  createdAfter: string;
  /** createdBefore timestamp (ISO datetime or `{today}`-style placeholder); "" = none. */
  createdBefore: string;
  /** Primary sort field; "" = no sort. */
  sortField: "" | SortField;
  /** Primary sort direction (meaningful when sortField !== ""). */
  sortDir: "asc" | "desc";
  /** Aggregation group-by; "" / absent = none. "isClass" | "presentAsMain" | `class:<id>` | `property:<id>`. */
  groupBy?: string;
  /** Aggregation measure. "count" (default) | "countDistinct" | `<fn>:<propertyId>`. */
  measure?: string;
}

export const DEFAULT_BUILDER_STATE: QueryBuilderState = {
  scope: "workspace",
  classId: null,
  isClass: "",
  presentAsMain: "",
  contains: "",
  createdAfter: "",
  createdBefore: "",
  sortField: "",
  sortDir: "asc",
  groupBy: "",
  measure: "count",
};

/**
 * The constructs the builder cannot represent, in stable display order.
 * Returns an empty array when the AST round-trips through the builder
 * losslessly (Apply rewrites it into the composed flat-AND shape, keeping
 * every represented condition).
 */
export function builderUnsupportedConstructs(ast: QueryAst | null): string[] {
  if (ast === null) return [];
  const found = new Set<string>();
  if (ast.scope.type === "linkedTo") found.add("a linked-to scope");

  const walkGroup = (group: QueryAst["root"], nested: boolean): void => {
    if (group.logic === "or") found.add("an OR group");
    if (nested) found.add("nested condition groups");
    for (const child of group.children) {
      if (child.type === "group") {
        walkGroup(child, true);
      } else if (child.type === "not") {
        found.add("NOT conditions");
      } else {
        switch (child.type) {
          case "property":
            found.add("property conditions");
            break;
          case "linkedTo":
            found.add("linked-to conditions");
            break;
          case "content":
            if (child.op === "fts") found.add("full-text search conditions");
            break;
          default:
            break; // class / isClass / presentAsMain / createdAfter / createdBefore are representable
        }
      }
    }
  };
  walkGroup(ast.root, false);

  if (ast.sort !== undefined && ast.sort.length > 1) found.add("multiple sort levels");
  const aggregation = ast.aggregation;
  if (aggregation !== undefined) {
    if (aggregation.dimensions.length > 1) found.add("multiple group-by dimensions");
    if (aggregation.measures.length > 1) found.add("multiple measures");
  }
  return [...found];
}

/**
 * Populate the builder from an AST, best effort: unsupported constructs read
 * back as defaults/omitted (callers gate on `builderUnsupportedConstructs`
 * first). The represented subset round-trips: scope, the flat
 * AND conditions (incl. the created window), the first sort spec, and the
 * first aggregation dimension/measure.
 */
export function extractBuilderState(ast: QueryAst | null): QueryBuilderState {
  if (ast === null) return { ...DEFAULT_BUILDER_STATE };
  const state = { ...DEFAULT_BUILDER_STATE };
  switch (ast.scope.type) {
    case "pages":
      state.scope = "pages";
      break;
    case "subtree":
      state.scope = "page";
      break;
    default:
      state.scope = "workspace";
      break;
  }
  if (ast.root.logic === "and") {
    for (const child of ast.root.children) {
      if (child.type === "class") state.classId = child.classId;
      else if (child.type === "isClass") state.isClass = child.isClass ? "true" : "false";
      else if (child.type === "presentAsMain") {
        state.presentAsMain = child.presentAsMain ? "true" : "false";
      } else if (child.type === "content" && child.op === "contains") {
        state.contains = child.value;
      } else if (child.type === "createdAfter") {
        state.createdAfter = child.timestamp;
      } else if (child.type === "createdBefore") {
        state.createdBefore = child.timestamp;
      }
    }
  }
  const sort: SortSpec | undefined = ast.sort?.[0];
  if (sort !== undefined) {
    state.sortField = sort.field;
    state.sortDir = sort.dir;
  }
  const aggregation = ast.aggregation;
  if (aggregation !== undefined) {
    const dimension = aggregation.dimensions[0];
    state.groupBy =
      dimension === undefined
        ? ""
        : dimension.kind === "isClass"
          ? "isClass"
          : dimension.kind === "presentAsMain"
            ? "presentAsMain"
            : `${dimension.kind}:${dimension.id}`;
    const measure = aggregation.measures[0];
    if (measure === undefined) {
      state.measure = "count";
    } else {
      switch (measure.function) {
        case "count":
        case "countDistinct":
          state.measure = measure.function;
          break;
        default:
          state.measure = `${measure.function}:${measure.id}`;
      }
    }
  }
  return state;
}

/**
 * The aggregation the builder state composes: absent unless a group-by is
 * set or the measure is non-default (a bare count with no dimensions is the
 * plain query's own badge). Empty dimensions + a numeric measure = the grand
 * total. `min:`/`max:` measures (hand-written in the AST) round-trip through
 * the state untouched even though the select does not offer them.
 */
export function composeAggregation(state: QueryBuilderState): QueryAst["aggregation"] {
  const groupBy = state.groupBy ?? "";
  const measureSpec = state.measure ?? "count";
  if (groupBy === "" && measureSpec === "count") return undefined;
  const dimensions: NonNullable<QueryAst["aggregation"]>["dimensions"] = [];
  if (groupBy === "isClass") {
    dimensions.push({ kind: "isClass" });
  } else if (groupBy === "presentAsMain") {
    dimensions.push({ kind: "presentAsMain" });
  } else if (groupBy.startsWith("class:")) {
    dimensions.push({ kind: "class", id: groupBy.slice("class:".length) });
  } else if (groupBy.startsWith("property:")) {
    dimensions.push({ kind: "property", id: groupBy.slice("property:".length) });
  }
  let measure: NonNullable<QueryAst["aggregation"]>["measures"][number];
  if (measureSpec === "count") {
    measure = { function: "count" };
  } else if (measureSpec === "countDistinct") {
    measure = { function: "countDistinct", kind: "node" };
  } else {
    const fn = measureSpec.slice(0, measureSpec.indexOf(":"));
    const id = measureSpec.slice(measureSpec.indexOf(":") + 1);
    measure = { function: fn as "sum" | "avg" | "min" | "max", kind: "property", id };
  }
  return { dimensions, measures: [measure] };
}

/** Compose the supported AST conditions into a version-1 AST (flat AND root). */
export function composeQueryAst(
  state: QueryBuilderState,
  rootId: string,
  rootIsPage: boolean,
): QueryAst {
  const scope: QueryAst["scope"] =
    state.scope === "pages"
      ? { type: "pages" }
      : state.scope === "page" && rootIsPage
        ? { type: "subtree", pageId: rootId }
        : { type: "entire_workspace" };
  const children: QueryAst["root"]["children"] = [];
  if (state.classId !== null && state.classId !== "") {
    children.push({ type: "class", classId: state.classId });
  }
  if (state.isClass !== "") children.push({ type: "isClass", isClass: state.isClass === "true" });
  if (state.presentAsMain !== "") {
    children.push({ type: "presentAsMain", presentAsMain: state.presentAsMain === "true" });
  }
  const contains = state.contains.trim();
  if (contains !== "") children.push({ type: "content", op: "contains", value: contains });
  const createdAfter = state.createdAfter.trim();
  if (createdAfter !== "") children.push({ type: "createdAfter", timestamp: createdAfter });
  const createdBefore = state.createdBefore.trim();
  if (createdBefore !== "") children.push({ type: "createdBefore", timestamp: createdBefore });
  const aggregation = composeAggregation(state);
  return {
    version: 1,
    scope,
    root: { type: "group", logic: "and", children },
    ...(state.sortField !== "" ? { sort: [{ field: state.sortField, dir: state.sortDir }] } : {}),
    ...(aggregation !== undefined ? { aggregation } : {}),
  };
}

/**
 * The read-only summary lines for the C1 guard (and the modal's recap):
 * what the builder CAN represent of this state, in display order. Values
 * are display strings, not raw ids.
 */
export function describeBuilderState(
  state: QueryBuilderState,
  labels: { className: (id: string) => string; propertyName: (id: string) => string },
): string[] {
  const lines: string[] = [];
  lines.push(
    state.scope === "pages"
      ? "Scope: pages only"
      : state.scope === "page"
        ? "Scope: this page"
        : "Scope: entire workspace",
  );
  if (state.classId !== null && state.classId !== "") {
    lines.push(`Class: ${labels.className(state.classId)}`);
  }
  if (state.isClass !== "") lines.push(`Class bit: ${state.isClass === "true" ? "class" : "not a class"}`);
  if (state.presentAsMain !== "") {
    lines.push(`Render bit: ${state.presentAsMain === "true" ? "main children" : "inline body"}`);
  }
  if (state.contains.trim() !== "") lines.push(`Text contains: "${state.contains.trim()}"`);
  if (state.createdAfter.trim() !== "") lines.push(`Created after: ${state.createdAfter.trim()}`);
  if (state.createdBefore.trim() !== "") lines.push(`Created before: ${state.createdBefore.trim()}`);
  if (state.sortField !== "") lines.push(`Sort: ${state.sortField} (${state.sortDir})`);
  const groupBy = state.groupBy ?? "";
  if (groupBy !== "") {
    const dimension =
      groupBy === "isClass"
        ? "Class bit"
        : groupBy === "presentAsMain"
          ? "Render bit"
          : groupBy.startsWith("class:")
            ? `Class: ${labels.className(groupBy.slice("class:".length))}`
            : `Property: ${labels.propertyName(groupBy.slice("property:".length))}`;
    lines.push(`Group by: ${dimension}`);
  }
  const measureSpec = state.measure ?? "count";
  if (groupBy !== "" || measureSpec !== "count") {
    const measure =
      measureSpec === "count"
        ? "Count"
        : measureSpec === "countDistinct"
          ? "Count distinct"
          : `${measureSpec.slice(0, measureSpec.indexOf(":")).toUpperCase()} of ${labels.propertyName(
              measureSpec.slice(measureSpec.indexOf(":") + 1),
            )}`;
    lines.push(`Measure: ${measure}`);
  }
  return lines;
}
