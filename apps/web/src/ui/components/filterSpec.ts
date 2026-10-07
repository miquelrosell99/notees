/**
 * filterSpec — the transient filter layer's ONE GRAMMAR (owner 2026-10-07).
 *
 * A filterable section renders a FilterBar whose state is a FilterSpec — the
 * documented subset of the query AST as plain, serializable data:
 *
 *   { text?, classId?, propertyPredicates[], dateRange? }
 *
 * One grammar with the stored custom views: a stored view persists a query
 * AST over its section's derived base row set; the flat-AND condition subset
 * the bar represents reads back through `queryAstToFilterSpec` and writes
 * forward through `filterSpecToQueryAst` — a spec round-trips onto exactly
 * the conditions it names, and an AST carrying anything outside the subset
 * reads back null (never a lossy default).
 *
 * Application (components/useSectionData.ts): the spec filters the section's
 * resolved rows POST-RESOLUTION and PRE-WINDOWING — windowing sees the
 * filtered set; the resolution cache is untouched (a spec change re-derives
 * from the cached rows, it never re-runs the query); the eager count stays
 * UNFILTERED (an active filter shows "0 of N", the section never vanishes).
 * The spec itself is component state — one instance per section view/tab,
 * lost on reload, nothing persisted.
 *
 * `matchesNodeFilter` mirrors the query compiler's scalar semantics over the
 * effective-values read model: text is a case-insensitive substring over the
 * row's title (title-is-content — the derived search-plaintext analogue);
 * classId is hierarchy-aware (the class or anything extending it);
 * property ops compare scalars (numeric when both sides are numeric,
 * lexicographic otherwise — the bar's text input coerces against numeric
 * values; the ISO-date arms match node-typed values by their deterministic
 * date-node id, the same containment/ordering arms the compiler emits); the
 * created window compares `created_at` inclusively and resolves
 * `{today}`-style placeholders on the run clock exactly as the compiler
 * does. Sort, aggregation, OR/NOT and every other AST construct are outside
 * the bar's subset by design.
 */

import { fullTitleOf, parseDateNodeId } from "@notees/domain";
import { resolveTimestampPlaceholder } from "@notees/query";

import type { Condition, PropertyOp, QueryAst, Scope } from "@notees/query";
import type { ClientNode, EffectiveProperty } from "@/core/workspace-client.js";

/** The property comparison ops — the query AST's PropertyOp verbatim. */
export const FILTER_PROPERTY_OPS: readonly PropertyOp[] = [
  "eq",
  "neq",
  "contains",
  "exists",
  "gt",
  "gte",
  "lt",
  "lte",
];

/** One property predicate — the query AST property condition's bar-facing shape. */
export interface FilterPropertyPredicate {
  schemaId: string;
  op: PropertyOp;
  /** The comparison bound (absent for `exists`). */
  value?: unknown;
}

/**
 * The transient FilterSpec — declarative, serializable, JSON-round-trippable.
 * Absent/empty fields are inactive; an all-empty spec is the identity filter.
 */
export interface FilterSpec {
  /** Case-insensitive substring over the row's title. */
  text?: string | undefined;
  /** Hierarchy-aware class membership (the class or anything extending it). */
  classId?: string | undefined;
  /** AND-ed property predicates over the effective-values read model. */
  propertyPredicates?: FilterPropertyPredicate[] | undefined;
  /** Inclusive created window (ISO dates or `{today}`-style placeholders). */
  dateRange?: { after?: string | undefined; before?: string | undefined } | undefined;
}

/**
 * The per-section facet configuration — `SectionSpec.filterable` and the
 * FilterBar's `config`. Every facet defaults on; `filterable: true` is the
 * full set, absent/false renders no bar at all.
 */
export interface FilterBarConfig {
  text?: boolean | undefined;
  class?: boolean | undefined;
  properties?: boolean | undefined;
  dateRange?: boolean | undefined;
}

/** The inactive spec — the bar's resting state. */
export const EMPTY_FILTER_SPEC: FilterSpec = {};

/** True when every facet is inactive (the identity filter — the hook skips it). */
export function isFilterEmpty(spec: FilterSpec): boolean {
  return (
    (spec.text?.trim() ?? "") === "" &&
    (spec.classId === undefined || spec.classId === "") &&
    (spec.propertyPredicates ?? []).length === 0 &&
    (spec.dateRange?.after?.trim() ?? "") === "" &&
    (spec.dateRange?.before?.trim() ?? "") === ""
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePredicate(input: unknown, index: number): FilterPropertyPredicate {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`filter spec: propertyPredicates[${index}] must be an object`);
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["schemaId", "op", "value"].includes(key)) {
      throw new Error(`filter spec: propertyPredicates[${index}] unknown key ${key}`);
    }
  }
  if (typeof raw.schemaId !== "string" || !UUID_RE.test(raw.schemaId)) {
    throw new Error(`filter spec: propertyPredicates[${index}].schemaId must be a uuid`);
  }
  if (typeof raw.op !== "string" || !FILTER_PROPERTY_OPS.includes(raw.op as PropertyOp)) {
    throw new Error(`filter spec: propertyPredicates[${index}].op is not a known op`);
  }
  const predicate: FilterPropertyPredicate = { schemaId: raw.schemaId, op: raw.op as PropertyOp };
  if (raw.value !== undefined) predicate.value = raw.value;
  return predicate;
}

/**
 * Parse + validate a serialized FilterSpec (the stored-view read path and
 * the round-trip gate). Unknown keys, bad shapes and unknown ops fail loud —
 * the strictness mirrors the query AST's zod schema.
 */
export function parseFilterSpec(input: unknown): FilterSpec {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("filter spec: expected an object");
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["text", "classId", "propertyPredicates", "dateRange"].includes(key)) {
      throw new Error(`filter spec: unknown key ${key}`);
    }
  }
  const spec: FilterSpec = {};
  if (raw.text !== undefined) {
    if (typeof raw.text !== "string") throw new Error("filter spec: text must be a string");
    spec.text = raw.text;
  }
  if (raw.classId !== undefined) {
    if (typeof raw.classId !== "string" || !UUID_RE.test(raw.classId)) {
      throw new Error("filter spec: classId must be a uuid");
    }
    spec.classId = raw.classId;
  }
  if (raw.propertyPredicates !== undefined) {
    if (!Array.isArray(raw.propertyPredicates)) {
      throw new Error("filter spec: propertyPredicates must be an array");
    }
    spec.propertyPredicates = raw.propertyPredicates.map(parsePredicate);
  }
  if (raw.dateRange !== undefined) {
    if (typeof raw.dateRange !== "object" || raw.dateRange === null || Array.isArray(raw.dateRange)) {
      throw new Error("filter spec: dateRange must be an object");
    }
    const range = raw.dateRange as Record<string, unknown>;
    for (const key of Object.keys(range)) {
      if (!["after", "before"].includes(key)) {
        throw new Error(`filter spec: dateRange unknown key ${key}`);
      }
    }
    const dateRange: FilterSpec["dateRange"] = {};
    if (range.after !== undefined) {
      if (typeof range.after !== "string" || range.after.trim() === "") {
        throw new Error("filter spec: dateRange.after must be a non-empty string");
      }
      dateRange.after = range.after;
    }
    if (range.before !== undefined) {
      if (typeof range.before !== "string" || range.before.trim() === "") {
        throw new Error("filter spec: dateRange.before must be a non-empty string");
      }
      dateRange.before = range.before;
    }
    spec.dateRange = dateRange;
  }
  return spec;
}

/** The spec's flat-AND condition set — the documented query-AST subset. */
export function filterSpecConditions(spec: FilterSpec): Condition[] {
  const children: Condition[] = [];
  const text = spec.text?.trim() ?? "";
  if (text !== "") children.push({ type: "content", op: "contains", value: text });
  if (spec.classId !== undefined && spec.classId !== "") {
    children.push({ type: "class", classId: spec.classId });
  }
  for (const predicate of spec.propertyPredicates ?? []) {
    children.push({
      type: "property",
      schemaId: predicate.schemaId,
      op: predicate.op,
      ...(predicate.value !== undefined ? { value: predicate.value } : {}),
    });
  }
  const after = spec.dateRange?.after?.trim() ?? "";
  if (after !== "") children.push({ type: "createdAfter", timestamp: after });
  const before = spec.dateRange?.before?.trim() ?? "";
  if (before !== "") children.push({ type: "createdBefore", timestamp: before });
  return children;
}

/** Compose the spec into a query AST (the one-grammar write direction). */
export function filterSpecToQueryAst(
  spec: FilterSpec,
  scope: Scope = { type: "entire_workspace" },
): QueryAst {
  return {
    version: 1,
    scope,
    root: { type: "group", logic: "and", children: filterSpecConditions(spec) },
  };
}

/**
 * Read an AST back into the bar's subset (the one-grammar read direction).
 * Returns null when the AST carries anything outside it — an OR root, a
 * nested group, a NOT, a non-contains content op, isClass/presentAsMain/
 * linkedTo/wire-field conditions, sort, or aggregation — never a lossy
 * default.
 */
export function queryAstToFilterSpec(ast: QueryAst): FilterSpec | null {
  if (ast.root.logic !== "and") return null;
  if (ast.sort !== undefined || ast.aggregation !== undefined) return null;
  const spec: FilterSpec = {};
  const dateRange: { after?: string; before?: string } = {};
  for (const child of ast.root.children) {
    if (child.type === "group" || child.type === "not") return null;
    switch (child.type) {
      case "content":
        if (child.op !== "contains" || spec.text !== undefined) return null;
        spec.text = child.value;
        break;
      case "class":
        if (spec.classId !== undefined) return null;
        spec.classId = child.classId;
        break;
      case "property": {
        const predicates = spec.propertyPredicates ?? [];
        predicates.push({
          schemaId: child.schemaId,
          op: child.op,
          ...(child.value !== undefined ? { value: child.value } : {}),
        });
        spec.propertyPredicates = predicates;
        break;
      }
      case "createdAfter":
        if (dateRange.after !== undefined) return null;
        dateRange.after = child.timestamp;
        break;
      case "createdBefore":
        if (dateRange.before !== undefined) return null;
        dateRange.before = child.timestamp;
        break;
      default:
        return null;
    }
  }
  if (dateRange.after !== undefined || dateRange.before !== undefined) {
    spec.dateRange = dateRange;
  }
  return spec;
}

/** The narrow client surface the row predicate reads (both clients satisfy it). */
export interface FilterFactsClient {
  /** The transitive extends closure (the hierarchy-aware class predicate). */
  getClassChildren(classId: string): ClientNode[];
  /** The effective-values read model (the property predicates). */
  getEffectiveProperties(id: string): EffectiveProperty[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict scalar equality, plus the numeric-string arm for the bar's text input. */
function scalarEquals(value: unknown, bound: unknown): boolean {
  if (value === bound) return true;
  if (typeof value === "number" && typeof bound === "string") {
    const trimmed = bound.trim();
    return trimmed !== "" && Number(trimmed) === value;
  }
  return false;
}

function numericBound(bound: unknown): number | null {
  if (typeof bound === "number") return bound;
  if (typeof bound === "string" && bound.trim() !== "" && !Number.isNaN(Number(bound))) {
    return Number(bound);
  }
  return null;
}

/** gt/gte/lt/lte — numeric when both sides are, lexicographic otherwise. */
function scalarOrder(value: unknown, op: PropertyOp, bound: unknown): boolean {
  const numBound = numericBound(bound);
  if (typeof value === "number" && numBound !== null) {
    switch (op) {
      case "gt":
        return value > numBound;
      case "gte":
        return value >= numBound;
      case "lt":
        return value < numBound;
      case "lte":
        return value <= numBound;
      default:
        return false;
    }
  }
  const left = String(value);
  const right = String(bound);
  switch (op) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    default:
      return false;
  }
}

/**
 * The date-ref containment arm the compiler emits for an ISO-date bound
 * against a node-typed value: a day node matches its exact day, a month node
 * the days it contains, a year node the days of its year.
 */
function dateRefEquals(nodeId: string, boundIso: string): boolean {
  const parsed = parseDateNodeId(nodeId);
  if (parsed === null) return false;
  const [year, month, day] = boundIso.split("-").map(Number) as [number, number, number];
  if (parsed.precision === "year") return parsed.year === year;
  if (parsed.precision === "month") return parsed.year === year && parsed.month === month;
  return parsed.year === year && parsed.month === month && parsed.day === day;
}

/** The date-ref ordering arm: the id's 12-digit payload vs the padded bound. */
function dateRefOrder(nodeId: string, op: PropertyOp, boundIso: string): boolean {
  const parsed = parseDateNodeId(nodeId);
  if (parsed === null) return false;
  const payload = nodeId.slice(24);
  const bound = `${boundIso.replace(/-/g, "")}0000`;
  switch (op) {
    case "gt":
      return payload > bound;
    case "gte":
      return payload >= bound;
    case "lt":
      return payload < bound;
    case "lte":
      return payload <= bound;
    default:
      return false;
  }
}

/** A node-typed property value's target id, when the value carries one. */
function refNodeIdOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const nodeId = (value as { nodeId?: unknown }).nodeId;
  return typeof nodeId === "string" ? nodeId : null;
}

/**
 * One effective value against one op — the compiler's scalar semantics plus
 * its ISO-date arms for node-typed (date) values.
 */
function valueMatches(value: unknown, op: PropertyOp, bound: unknown): boolean {
  if (value === null || value === undefined) return false;
  const boundIso = typeof bound === "string" && ISO_DATE_RE.test(bound) ? bound : null;
  if (boundIso !== null && typeof value === "object") {
    // The compiler gates the scalar arm off for object values under a date
    // bound — only the date-ref arms speak; a non-date ref matches nothing
    // but neq (the JSON text never equals the dashed ISO bound).
    const nodeId = refNodeIdOf(value);
    if (nodeId === null) return op === "neq";
    if (op === "eq") return dateRefEquals(nodeId, boundIso);
    if (op === "neq") return !dateRefEquals(nodeId, boundIso);
    if (op === "contains") {
      return (
        dateRefEquals(nodeId, boundIso) ||
        String(value).toLowerCase().includes(String(bound).toLowerCase())
      );
    }
    return dateRefOrder(nodeId, op, boundIso);
  }
  switch (op) {
    case "eq":
      return scalarEquals(value, bound);
    case "neq":
      return !scalarEquals(value, bound);
    case "contains":
      return String(value).toLowerCase().includes(String(bound).toLowerCase());
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return scalarOrder(value, op, bound);
    default:
      return false;
  }
}

/** One property predicate against the node's effective values (any row may match). */
function propertyMatches(
  client: FilterFactsClient,
  nodeId: string,
  predicate: FilterPropertyPredicate,
): boolean {
  const rows = client
    .getEffectiveProperties(nodeId)
    .filter((row) => row.propertySchemaId === predicate.schemaId);
  if (predicate.op === "exists") return rows.length > 0;
  // Value ops require a non-null bound (the compile law); without one the
  // predicate can match nothing.
  if (predicate.value === undefined || predicate.value === null) return false;
  return rows.some((row) => valueMatches(row.value, predicate.op, predicate.value));
}

/**
 * The row predicate — true when the node's row survives the spec. Every
 * active facet ANDs; an all-empty spec is the identity (true).
 */
export function matchesNodeFilter(
  client: FilterFactsClient,
  node: ClientNode,
  spec: FilterSpec,
): boolean {
  if (isFilterEmpty(spec)) return true;
  const text = spec.text?.trim() ?? "";
  if (text !== "" && !fullTitleOf(node).toLowerCase().includes(text.toLowerCase())) {
    return false;
  }
  const classId = spec.classId;
  if (classId !== undefined && classId !== "") {
    const closure = new Set([
      classId,
      ...client.getClassChildren(classId).map((child) => child.id),
    ]);
    if (!node.classIds.some((id) => closure.has(id))) return false;
  }
  for (const predicate of spec.propertyPredicates ?? []) {
    if (!propertyMatches(client, node.id, predicate)) return false;
  }
  const after = spec.dateRange?.after?.trim() ?? "";
  if (after !== "") {
    if (node.createdAt === null || node.createdAt < resolveTimestampPlaceholder(after, "after")) {
      return false;
    }
  }
  const before = spec.dateRange?.before?.trim() ?? "";
  if (before !== "") {
    if (node.createdAt === null || node.createdAt > resolveTimestampPlaceholder(before, "before")) {
      return false;
    }
  }
  return true;
}
