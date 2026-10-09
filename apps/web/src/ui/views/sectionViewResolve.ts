/**
 * sectionViewResolve — the hosted-views resolution: a stored custom view's
 * query_ast refines the section's base row set.
 *
 * The composition contract (the design's resolution rule):
 *
 *  - The section's base query produces the row set (the section's own read —
 *    linked references, unlinked mentions, class members); the stored AST
 *    composes ON TOP of it. The stored scope is therefore IGNORED: the base
 *    set IS the scope. Only the root condition group refines, plus `sort`.
 *  - A stored aggregation is likewise not a row-set refinement — the tab
 *    renders rows, so resolution ignores `aggregation`. The AST round-trips
 *    verbatim through the store (nothing is rewritten or dropped), and a
 *    future slice can render aggregate tabs from the same rows.
 *
 * Push-down (where each predicate evaluates):
 *
 *  - Base-column conditions evaluate directly on the materialized row (the
 *    ClientNode carries the node's own columns): `isClass`, `presentAsMain`,
 *    the created window (`createdAfter`/`createdBefore`, `{today}`-style
 *    placeholders resolved against the run clock), `class` membership (the
 *    row's direct class_ids against the class + its transitive extending
 *    classes), `content` contains (LIKE semantics — an ASCII case-insensitive
 *    substring over the flattened title text, the same plaintext the derived
 *    search index holds), and the three wire-field predicates
 *    (`coverAsset`/`bannerAsset`/`aliasedNode`).
 *  - `property` conditions (the effective-values read model) evaluate
 *    synchronously on the row too (owner 2026-10-08, the one-evaluation
 *    ruling): the client's `getEffectiveProperties` is the same read model
 *    the compiler's property arm reads, so the hosted custom tabs stop
 *    probing for them. Only `content` fts (the FTS index) and `linkedTo`
 *    (the edge roll-up) remain probe-path leaves — one membership probe per
 *    leaf through the established `runQueryAst` channel over the workspace,
 *    intersected with the base set. The derived store owns those read
 *    models; re-deriving them here would duplicate the query package. The
 *    FilterBuilderModal's representable subset never produces these (its
 *    guard names them unsupported), so the common custom tab evaluates
 *    wholly on the materialized rows.
 *
 * Sort applies client-side with the compiler's semantics: `name` orders by
 * the flattened title text (empty falls last), `createdAt` lexicographic,
 * `isClass`/`presentAsMain` by bit; every sort ends in the `id ASC` tiebreak.
 * Groups refine alongside items (a group's rows filter by the same
 * predicate; emptied groups drop), so grouped rendering (the backlinks
 * containing-page groups) stays consistent.
 */

import { useEffect, useMemo, useState } from "react";

import { plainTextExcerpt, parseDateNodeId } from "@notees/domain";
import { parseQueryAst, resolveTimestampPlaceholder, type PropertyOp, type QueryAst } from "@notees/query";

import type { ClientNode, EffectiveProperty } from "@/core/workspace-client.js";

import type { CollectionGroup, NodeCollectionItem } from "./types.js";

/** The client surface resolution needs (both client classes satisfy it). */
export interface SectionViewResolveClient {
  /** The node read (the descendantOf ancestor-chain walk). */
  getNode(id: string): ClientNode | undefined;
  getClassChildren(classId: string): ClientNode[];
  /** The effective-values read model (the property condition's sync arm). */
  getEffectiveProperties(id: string): EffectiveProperty[];
  runQueryAst(rawAst: unknown):
    | { ids: string[] }
    | Promise<{ ids: string[] }>;
  /** The notify subscription the probe path's freshness rides. */
  subscribe(listener: () => void): () => void;
}

export interface SectionViewResolution {
  items: NodeCollectionItem[];
  groups: CollectionGroup[] | undefined;
  /** A parse/compile failure — the chrome renders the error, the section stays. */
  error: string | null;
}

export interface SectionViewPlan {
  ast: QueryAst;
  /** True when the root tree contains joined-metadata leaves (probe path). */
  needsProbe: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Group/not/or-recursive scan for joined-metadata leaves. */
function treeNeedsProbe(children: QueryAst["root"]["children"]): boolean {
  for (const child of children) {
    if (child.type === "group") {
      if (treeNeedsProbe(child.children)) return true;
    } else if (child.type === "not") {
      if (child.child.type === "group" ? treeNeedsProbe(child.child.children) : leafNeedsProbe(child.child)) {
        return true;
      }
    } else if (leafNeedsProbe(child)) {
      return true;
    }
  }
  return false;
}

function leafNeedsProbe(condition: QueryAst["root"]["children"][number]): boolean {
  if (condition.type === "linkedTo") return true;
  // Dynamic target sets resolve through the query channel (edges + the
  // nested group's own leaves) — never locally.
  if (condition.type === "linkedToQuery") return true;
  if (condition.type === "descendantOfQuery") return true;
  if (condition.type === "content" && condition.op === "fts") return true;
  return false;
}

/**
 * Parse + plan a stored AST. Throws on invalid input (the server validated at
 * write time; a corrupt device row must fail loud, never half-apply).
 */
export function planSectionView(rawAst: unknown): SectionViewPlan {
  const ast = parseQueryAst(rawAst);
  return { ast, needsProbe: treeNeedsProbe(ast.root.children) };
}

// --- base-column evaluation -------------------------------------------------------

/** SQLite LIKE's case folding is ASCII-only; match it exactly. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

function titleTextOf(node: ClientNode): string {
  return plainTextExcerpt(node.contentAst).trim();
}

/**
 * The class closure (the class + its transitive extending classes): a row
 * matches a `class` condition when its direct class_ids hit the closure —
 * the same hierarchy-aware probe as the compiler's class_hierarchy read.
 */
function classClosureOf(client: SectionViewResolveClient, classId: string): Set<string> {
  const closure = new Set<string>([classId]);
  for (const child of client.getClassChildren(classId)) closure.add(child.id);
  return closure;
}

function wireFieldMatches(
  node: ClientNode,
  kind: "coverAsset" | "bannerAsset" | "aliasedNode",
  op: "eq" | "neq" | "exists",
  value: string | undefined,
): boolean {
  const actual =
    kind === "coverAsset" ? node.coverAssetId : kind === "bannerAsset" ? node.bannerAssetId : node.aliasedNodeId;
  // SQL NULL semantics: an unset field matches neither eq nor neq.
  if (op === "exists") return actual !== null;
  if (actual === null || value === undefined) return false;
  return op === "eq" ? actual === value : actual !== value;
}

// --- property scalar semantics (the compiler's arms, verbatim) ----------------

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

/** One property condition against the node's effective rows (any row may match). */
function propertyMatches(
  ctx: EvalContext,
  nodeId: string,
  condition: Extract<QueryAst["root"]["children"][number], { type: "property" }>,
): boolean {
  let rows = ctx.client
    .getEffectiveProperties(nodeId)
    .filter((row) => row.propertySchemaId === condition.schemaId);
  if (condition.includeDefaults === false) {
    rows = rows.filter((row) => row.source === "authored");
  }
  if (condition.op === "exists") return rows.length > 0;
  // Value ops require a non-null bound (the compile law); without one the
  // condition can match nothing.
  if (condition.value === undefined || condition.value === null) return false;
  return rows.some((row) => valueMatches(row.value, condition.op, condition.value));
}

interface EvalContext {
  client: SectionViewResolveClient;
  /** Memoized class closures per classId (one getClassChildren per refinement). */
  closures: Map<string, Set<string>>;
  /** Resolved `{today}`-style bounds per condition (the run clock). */
  bounds: Map<string, string>;
}

function conditionMatches(ctx: EvalContext, condition: QueryAst["root"]["children"][number], item: NodeCollectionItem): boolean {
  const node = item.node;
  switch (condition.type) {
    case "class": {
      let closure = ctx.closures.get(condition.classId);
      if (closure === undefined) {
        closure = classClosureOf(ctx.client, condition.classId);
        ctx.closures.set(condition.classId, closure);
      }
      return node.classIds.some((id) => closure!.has(id));
    }
    case "isClass":
      return node.isClass === condition.isClass;
    case "presentAsMain":
      return node.presentAsMain === condition.presentAsMain;
    case "content":
      // contains only — fts rides the probe path (treeNeedsProbe).
      return asciiLower(titleTextOf(node)).includes(asciiLower(condition.value));
    case "property":
      // The one-evaluation ruling (owner 2026-10-08): property conditions
      // evaluate synchronously over the effective-values read model — the
      // same read the compiler's property arm makes in the derived store.
      return propertyMatches(ctx, node.id, condition);
    case "createdAfter":
    case "createdBefore":
    case "updatedAfter":
    case "updatedBefore": {
      const key = `${condition.type}:${condition.timestamp}`;
      let bound = ctx.bounds.get(key);
      if (bound === undefined) {
        bound = resolveTimestampPlaceholder(
          condition.timestamp,
          condition.type === "createdAfter" ? "after" : "before",
        );
        ctx.bounds.set(key, bound);
      }
      const column = condition.type.startsWith("updated") ? node.updatedAt : node.createdAt;
      if (column === null) return false;
      const after = condition.type === "createdAfter" || condition.type === "updatedAfter";
      return after ? column >= bound : column <= bound;
    }
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return wireFieldMatches(node, condition.type, condition.op, condition.value);
    case "descendantOf": {
      // Ancestor-chain walk (the "parent is X anywhere up the tree"
      // condition): the node itself is excluded — start at the parent.
      // Cycle-guarded: impossible states are write-time impossible, but a
      // corrupt row must fail loud-quiet (no infinite loop), not hang.
      const seen = new Set<string>([node.id]);
      let current = node.parentId;
      while (current !== null && !seen.has(current)) {
        if (current === condition.nodeId) return true;
        seen.add(current);
        const parent = ctx.client.getNode(current);
        current = parent?.parentId ?? null;
      }
      return false;
    }
    default:
      // Joined-metadata leaves — the probe path evaluates these; the sync
      // path never reaches here (planSectionView flagged needsProbe).
      throw new Error(`query resolve: condition '${condition.type}' requires the membership probe`);
  }
}

function groupMatches(ctx: EvalContext, children: QueryAst["root"]["children"], logic: "and" | "or", item: NodeCollectionItem): boolean {
  if (children.length === 0) return true; // empty group = no constraint
  return logic === "and"
    ? children.every((child) => childMatches(ctx, child, item))
    : children.some((child) => childMatches(ctx, child, item));
}

function childMatches(ctx: EvalContext, child: QueryAst["root"]["children"][number], item: NodeCollectionItem): boolean {
  if (child.type === "group") return groupMatches(ctx, child.children, child.logic, item);
  if (child.type === "not") {
    const inner =
      child.child.type === "group"
        ? groupMatches(ctx, child.child.children, child.child.logic, item)
        : conditionMatches(ctx, child.child, item);
    return !inner;
  }
  return conditionMatches(ctx, child, item);
}

/**
 * The shared row predicate for a planned AST: one EvalContext (memoized
 * class closures and placeholder bounds) closing over the root group. The
 * transient filter layer and any synchronous consumer filter rows with this —
 * the same conditionMatches/groupMatches the resolution uses, never a
 * second evaluator. Only valid for plans WITHOUT probe leaves (the bar's
 * subset); a probe leaf would throw here by design.
 */
export function createSectionViewMatcher(
  client: SectionViewResolveClient,
  plan: SectionViewPlan,
): (node: ClientNode) => boolean {
  const ctx: EvalContext = { client, closures: new Map(), bounds: new Map() };
  return (node) => groupMatches(ctx, plan.ast.root.children, plan.ast.root.logic, { node });
}

// --- sort --------------------------------------------------------------------------

type SortField = NonNullable<QueryAst["sort"]>[number]["field"];

function sortValueOf(field: SortField, item: NodeCollectionItem): string | number | null {
  switch (field) {
    case "name": {
      const title = titleTextOf(item.node);
      return title === "" ? null : title;
    }
    case "createdAt":
      return item.node.createdAt;
    case "isClass":
      return item.node.isClass ? 1 : 0;
    case "presentAsMain":
      return item.node.presentAsMain ? 1 : 0;
  }
}

/** The compiler's ORDER BY semantics: nullable columns NULLs-last, id tiebreak. */
function compareBySort(sort: NonNullable<QueryAst["sort"]>): (a: NodeCollectionItem, b: NodeCollectionItem) => number {
  return (a, b) => {
    for (const spec of sort) {
      const av = sortValueOf(spec.field, a);
      const bv = sortValueOf(spec.field, b);
      if (av === null && bv === null) continue;
      if (av === null) return 1; // NULLs last, both directions
      if (bv === null) return -1;
      if (av === bv) continue;
      const cmp = av < bv ? -1 : 1;
      return spec.dir === "desc" ? -cmp : cmp;
    }
    return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
  };
}

// --- the resolution steps ------------------------------------------------------------

function filterItems(ctx: EvalContext, ast: QueryAst, items: NodeCollectionItem[]): NodeCollectionItem[] {
  return items.filter((item) => groupMatches(ctx, ast.root.children, ast.root.logic, item));
}

function filterGroups(ctx: EvalContext, ast: QueryAst, groups: CollectionGroup[] | undefined): CollectionGroup[] | undefined {
  if (groups === undefined) return undefined;
  return groups
    .map((group) => ({ ...group, items: filterItems(ctx, ast, group.items) }))
    .filter((group) => group.items.length > 0);
}

/**
 * The SYNC resolution (no joined-metadata leaves): filter + sort wholly on
 * the materialized rows. Pure with respect to the rows — safe per render.
 * A no-op refinement returns the base arrays BY IDENTITY (the hosted default
 * tab and the empty-AST path never churn row identity into the view).
 */
export function applySectionView(
  client: SectionViewResolveClient,
  base: { items: NodeCollectionItem[]; groups: CollectionGroup[] | undefined },
  plan: SectionViewPlan,
): { items: NodeCollectionItem[]; groups: CollectionGroup[] | undefined } {
  if (plan.ast.root.children.length === 0 && (plan.ast.sort === undefined || plan.ast.sort.length === 0)) {
    return { items: base.items, groups: base.groups };
  }
  const ctx: EvalContext = { client, closures: new Map(), bounds: new Map() };
  const allKept = (source: NodeCollectionItem[]) => {
    let kept = true;
    for (const entry of source) {
      if (!groupMatches(ctx, plan.ast.root.children, plan.ast.root.logic, entry)) {
        kept = false;
        break;
      }
    }
    return kept;
  };
  const items = allKept(base.items) ? base.items : filterItems(ctx, plan.ast, base.items);
  const groups =
    base.groups === undefined
      ? undefined
      : base.groups.every((group) => allKept(group.items))
        ? base.groups
        : filterGroups(ctx, plan.ast, base.groups);
  if (plan.ast.sort !== undefined && plan.ast.sort.length > 0) {
    // Groups keep their container's order — a grouped view sorts within the
    // refinement only when the caller renders flat rows.
    return { items: [...items].sort(compareBySort(plan.ast.sort)), groups };
  }
  return { items, groups };
}

/**
 * The probe path (joined-metadata leaves): one membership query per probe
 * leaf through the established runQueryAst channel, intersected with the
 * base set. Returns the resolved rows.
 */
export async function resolveSectionViewProbed(
  client: SectionViewResolveClient,
  base: { items: NodeCollectionItem[]; groups: CollectionGroup[] | undefined },
  plan: SectionViewPlan,
): Promise<{ items: NodeCollectionItem[]; groups: CollectionGroup[] | undefined }> {
  const probes = new Map<string, Set<string>>();
  const probeFor = async (condition: QueryAst["root"]["children"][number]): Promise<Set<string>> => {
    const key = JSON.stringify(condition);
    const existing = probes.get(key);
    if (existing !== undefined) return existing;
    const result = await Promise.resolve(
      client.runQueryAst({
        version: 1,
        scope: { type: "entire_workspace" },
        root: { type: "group", logic: "and", children: [condition] },
      }),
    );
    const ids = new Set(result.ids.map(String));
    probes.set(key, ids);
    return ids;
  };

  const ctx: EvalContext = { client, closures: new Map(), bounds: new Map() };
  const matches = async (child: QueryAst["root"]["children"][number], item: NodeCollectionItem): Promise<boolean> => {
    if (child.type === "group") {
      // Empty group = no constraint, both logics (matches the sync path).
      if (child.children.length === 0) return true;
      const results = await Promise.all(child.children.map((nested) => matches(nested, item)));
      return child.logic === "and" ? results.every(Boolean) : results.some(Boolean);
    }
    if (child.type === "not") {
      const inner =
        child.child.type === "group"
          ? await matches({ type: "group", logic: child.child.logic, children: child.child.children }, item)
          : await matches(child.child, item);
      return !inner;
    }
    if (!leafNeedsProbe(child)) {
      return conditionMatches(ctx, child, item);
    }
    const ids = await probeFor(child);
    return ids.has(item.node.id);
  };

  const kept: NodeCollectionItem[] = [];
  for (const item of base.items) {
    if (await matches({ type: "group", logic: plan.ast.root.logic, children: plan.ast.root.children }, item)) {
      kept.push(item);
    }
  }
  let items = kept;
  const groups =
    base.groups === undefined
      ? undefined
      : (await Promise.all(
          base.groups.map(async (group) => ({
            ...group,
            items: (
              await Promise.all(group.items.map(async (item) => ((await matches({ type: "group", logic: plan.ast.root.logic, children: plan.ast.root.children }, item)) ? item : null)))
            ).filter((item): item is NodeCollectionItem => item !== null),
          })),
        )).filter((group) => group.items.length > 0);
  if (plan.ast.sort !== undefined && plan.ast.sort.length > 0) {
    items = [...items].sort(compareBySort(plan.ast.sort));
  }
  return { items, groups };
}

// --- the hook ------------------------------------------------------------------------

/**
 * The NodeCollection integration: resolve the selected custom view against
 * the base rows. The sync path recomputes per render (a pure filter — row
 * identity churn is silent on it); the probe path runs in an effect keyed on
 * the row-id signature + the client notification version, so identity churn
 * never loops and notifications re-probe.
 */
export function useSectionViewResolution(
  client: SectionViewResolveClient,
  items: NodeCollectionItem[],
  groups: CollectionGroup[] | undefined,
  view: { id: string; queryAst: unknown } | null | undefined,
): SectionViewResolution {
  const [probed, setProbed] = useState<{ key: string; items?: NodeCollectionItem[]; groups?: CollectionGroup[] | undefined; error?: string } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const rawAst = view?.queryAst ?? null;
  const astKey = JSON.stringify(rawAst ?? null);
  const plan = useMemo<SectionViewPlan | { error: string } | null>(() => {
    if (rawAst === null) return null;
    try {
      return planSectionView(rawAst);
    } catch (error) {
      return { error: errorMessage(error) };
    }
    // The serialized AST is the identity — the view object may be replaced
    // by a server refresh with an equal AST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [astKey]);

  const base: SectionViewResolution = { items, groups, error: null };
  const needsProbe = plan !== null && !("error" in plan) && plan.needsProbe;
  const signature = needsProbe
    ? `${astKey}|${items.map((item) => item.node.id).join(",")}|${(groups ?? []).map((group) => group.id).join(",")}|${version}`
    : "";

  useEffect(() => {
    if (!needsProbe || plan === null || "error" in plan) return;
    let cancelled = false;
    void resolveSectionViewProbed(client, { items, groups }, plan)
      .then((result) => {
        if (!cancelled) setProbed({ key: signature, items: result.items, groups: result.groups });
      })
      .catch((error: unknown) => {
        if (!cancelled) setProbed({ key: signature, error: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, needsProbe, astKey, signature]);

  if (plan === null) return base;
  if ("error" in plan) return { ...base, error: plan.error };
  if (!needsProbe) {
    try {
      return { ...applySectionView(client, { items, groups }, plan), error: null };
    } catch (error) {
      return { ...base, error: errorMessage(error) };
    }
  }
  if (probed === null || probed.key !== signature) return base; // first probe still running
  if (probed.error !== undefined) return { ...base, error: probed.error };
  return { items: probed.items ?? items, groups: probed.groups, error: null };
}
