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
 *    ClientNode carries the node's own columns): the member families' ids-
 *    mode predicates and set bits (class closure membership, tags, the
 *    parent/child/childPath/page/parentPath/root walks), the nodeField wire
 *    predicates (`isClass`/`isEmbedded`/`coverAsset`/`bannerAsset`/
 *    `aliasedNode`), the date family's created/updated windows (`{today}`-
 *    style placeholders resolved against the run clock), `content` over the
 *    FULL derived search plaintext (the store's extractSearchPlaintext,
 *    ported over the client reads — the mention-resolved excerpt + asset
 *    original names + text-ish property values, diacritic-folded; a node
 *    with no plaintext matches nothing, SQL NULL semantics), and `name`
 *    title-only (the compiler's nameSql, deliberately not the search row).
 *  - `property` conditions (the effective-values read model) evaluate
 *    synchronously on the row too (the one-evaluation
 *    ruling): the client's `getEffectiveProperties` is the same read model
 *    the compiler's property arm reads, and comparison bounds resolve
 *    `{today}`-style value placeholders through the compiler's own
 *    `resolveValuePlaceholder` against the run clock (the same gate: the
 *    value ops only — contains and the between/within bounds stay literal),
 *    so the hosted custom tabs stop probing for them. Only `content` fts
 *    (the FTS index), the
 *    links/referencePath member families (the edge roll-up), and any member
 *    with a query/self target remain probe-path leaves — one membership
 *    probe per leaf through the established `runQueryAst` channel over the
 *    workspace, intersected with the base set. The derived store owns those
 *    read models; re-deriving them here would duplicate the query package.
 *    The transient structured-filters draft never produces these (its guard
 *    names them unsupported), so the common custom tab evaluates wholly on
 *    the materialized rows.
 *
 * Sort applies client-side with the compiler's semantics: `name` orders by
 * the flattened title text (empty falls last), `createdAt` lexicographic,
 * `isClass`/`isEmbedded` by bit; every sort ends in the `id ASC` tiebreak.
 * Groups refine alongside items (a group's rows filter by the same
 * predicate; emptied groups drop), so grouped rendering (the backlinks
 * containing-page groups) stays consistent. The ungrouped rows (the
 * references grouping's page sources) refine the same way and keep their
 * container's order — never sorted by the refinement (the groups'
 * precedent), the view's own sort button orders them.
 */

import { useEffect, useMemo, useState } from "react";

import { deriveDisplayName, plainTextExcerpt, parseDateNodeId } from "@notees/domain";
import { parseQueryAst, placeholderEndDate, placeholderStartDate, resolveDayBounds, resolvePeriodBounds, resolveTimestampPlaceholder, resolveValuePlaceholder, type CompileOptions, type Condition, type DateOp, type PropertyOp, type QueryAst } from "@notees/query";

import type { ClientNode, EffectiveProperty } from "@/core/workspace-client/index.js";

import type { CollectionGroup, NodeCollectionItem } from "./types.js";

/** The client surface resolution needs (both client classes satisfy it). */
export interface SectionViewResolveClient {
  /** The node read (the descendantOf ancestor-chain walk). */
  getNode(id: string): ClientNode | undefined;
  getClassChildren(classId: string): ClientNode[];
  /** The direct-children read (the child / child-path conditions' sync arms). */
  getChildren(id: string): ClientNode[];
  /** The effective-values read model (the property condition's sync arm). */
  getEffectiveProperties(id: string): EffectiveProperty[];
  /** The asset-metadata read (the content plaintext's asset original names). */
  getAssetInfo(id: string): { originalName: string } | undefined;
  /** The property-schema read (select option labels for the content plaintext). */
  listPropertySchemas(): ReadonlyArray<{
    id: string;
    type: string;
    options?: ReadonlyArray<{ id: string; label: string }> | null;
  }>;
  runQueryAst(rawAst: unknown, options?: CompileOptions):
    | { ids: string[] }
    | Promise<{ ids: string[] }>;
  /** The notify subscription the probe path's freshness rides. */
  subscribe(listener: () => void): () => void;
}

export interface SectionViewResolution {
  items: NodeCollectionItem[];
  groups: CollectionGroup[] | undefined;
  /** The rows belonging to no group (the references grouping's page sources) — filtered like the items. */
  ungrouped: NodeCollectionItem[] | undefined;
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
  if (condition.type === "content" && condition.op === "fts") return true;
  if (condition.type !== "member") return false;
  // The links/referencePath families read the edge table (joined metadata
  // the materialized row does not carry) — every op, every target mode.
  if (condition.family === "links" || condition.family === "referencePath") return true;
  // The query/self target modes resolve through the query channel (the
  // nested group's own leaves, the run-context host) — never locally. Only
  // the ids mode (and the set bits) evaluate on the materialized rows.
  if (condition.op === "in" || condition.op === "not-in") {
    return condition.target.mode !== "ids";
  }
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

/**
 * Closure-aware class-membership test for one node (the `class` condition's
 * semantics, shared by the classed-ancestor/page/root arms) — memoized per
 * classId on the eval context, like the `class` arm.
 */
function classedWith(ctx: EvalContext, node: ClientNode, classId: string): boolean {
  let closure = ctx.closures.get(classId);
  if (closure === undefined) {
    closure = classClosureOf(ctx.client, classId);
    ctx.closures.set(classId, closure);
  }
  return node.classIds.some((id) => closure!.has(id));
}

/**
 * The Odoo date comparison (the date condition's eq/neq/gt/gte/lt/lte ops)
 * — the evaluator mirror of
 * the compiler's dateCmpSql: eq/neq are DAY-granular (the whole resolved
 * local day matches), gt/gte/lt/lte compare against the resolved instant.
 * A NULL column (never-edited for updated_at) matches nothing but neq/set.
 */
function dateCmpMatches(column: string | null, op: DateOp, timestamp: string): boolean {
  if (op === "eq" || op === "neq") {
    const day = resolveDayBounds(timestamp);
    const inDay = column !== null && column >= day.from && column <= day.to;
    return op === "eq" ? inDay : !inDay;
  }
  if (column === null) return false;
  const bound = resolveTimestampPlaceholder(timestamp, op === "gt" || op === "gte" ? "after" : "before");
  switch (op) {
    case "gt":
      return column > bound;
    case "gte":
      return column >= bound;
    case "lt":
      return column < bound;
    case "lte":
      return column <= bound;
    default:
      return false;
  }
}

/**
 * The containing page of a node — the nearest self-or-ancestor rendering
 * with document chrome (the Revision-12 page-role walk, cycle-guarded). The
 * SELF target mode's anchor: a query block's host is its containing page,
 * never the block itself (nothing usefully points at the block).
 */
export function containingPageIdOf(
  client: Pick<SectionViewResolveClient, "getNode">,
  nodeId: string,
): string | undefined {
  const seen = new Set<string>();
  let current = client.getNode(nodeId);
  while (current !== undefined) {
    if (current.isClass || current.parentId === null || !current.isEmbedded) return current.id;
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    current = client.getNode(current.parentId);
  }
  return undefined;
}

/**
 * The containing page walk (Revision-12 page role, flattened the same way the
 * compiler's "pages" scope flattens it): the nearest self-or-ancestor that is
 * a class, parentless, or is_embedded=0 — standalone-under-a-non-page parent
 * is write-time impossible, so the flat test is exact. Cycle-guarded.
 */
function containingPageOf(ctx: EvalContext, node: ClientNode): ClientNode | undefined {
  const id = containingPageIdOf(ctx.client, node.id);
  return id !== undefined ? ctx.client.getNode(id) : undefined;
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
  if (condition.op === "exists") {
    // The compiler's exists arm tests the effective CTE for a row at all —
    // its rows always carry a value (visible authored values UNION non-null
    // derived defaults; emptied/declared-only rows create no row). The
    // client's effective read ALSO synthesizes bound-but-empty and assigned
    // virtual rows (value null — the property panel's declaration rows),
    // which must NOT count: "is set" means HAS A VALUE, not HAS A
    // DECLARATION.
    return rows.some((row) => row.value !== null && row.value !== undefined);
  }
  // Value ops require a non-null bound (the compile law); without one the
  // condition can match nothing. (between/within intercept in
  // conditionMatches before this read.)
  if (condition.value === undefined || condition.value === null) return false;
  const op = condition.op as PropertyOp;
  // The comparison bound rides the placeholder clock — the compiler's
  // propertySql gate mirrored exactly: a `{today}`-style token in a string
  // bound resolves to the period start (a plain YYYY-MM-DD date) for the
  // value ops; contains is a text-substring op and exists carries no value,
  // so neither resolves. between/within keep their literal bounds above
  // (propertyRangeSql pushes them raw — parity is literal there).
  const bound =
    typeof condition.value === "string" && op !== "contains" && op !== "exists"
      ? resolveValuePlaceholder(condition.value)
      : condition.value;
  return rows.some((row) => valueMatches(row.value, op, bound));
}

interface EvalContext {
  client: SectionViewResolveClient;
  /** Memoized class closures per classId (one getClassChildren per refinement). */
  closures: Map<string, Set<string>>;
  /** Resolved `{today}`-style bounds per condition (the run clock). */
  bounds: Map<string, string>;
  /** Memoized asset original names per asset id (the content plaintext). */
  assetNames: Map<string, string | null>;
  /** Memoized derived search plaintexts per node id (the content arm). */
  plaintexts: Map<string, string>;
  /** The property-schema list, lazily pulled once per refinement (null = not yet). */
  schemas: Map<string, { id: string; type: string; options?: ReadonlyArray<{ id: string; label: string }> | null }> | null;
}

// --- the derived search plaintext (the compiler's content arm contract) ---------------
//
// The compiler's contentSql predicates run over the derived FTS row —
// packages/store/src/content.ts's extractSearchPlaintext: the content
// plaintext (mention-resolved excerpt + asset original names) UNION the
// text-ish property values, diacritic-folded at index time (store search.ts
// foldSearchText). The functions below port that derivation over the client
// read surface — they MUST mirror the store: a drift here is a sync/probe
// parity bug, silent until a hosted view disagrees with the probe.

/** Diacritic folding — the mirror of the store's foldSearchText (index time). */
function foldSearchText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

/** The property-schema list, lazily materialized once per refinement. */
function schemaOf(
  ctx: EvalContext,
  schemaId: string,
): { id: string; type: string; options?: ReadonlyArray<{ id: string; label: string }> | null } | undefined {
  if (ctx.schemas === null) {
    ctx.schemas = new Map();
    for (const schema of ctx.client.listPropertySchemas()) ctx.schemas.set(schema.id, schema);
  }
  return ctx.schemas.get(schemaId);
}

/** Asset original name per asset id (memoized; null when the row is gone). */
function assetNameOf(ctx: EvalContext, assetId: string): string | null {
  let name = ctx.assetNames.get(assetId);
  if (name === undefined) {
    name = ctx.client.getAssetInfo(assetId)?.originalName ?? null;
    ctx.assetNames.set(assetId, name);
  }
  return name;
}

/**
 * A mention target's CURRENT display name — the port of the store's
 * resolveMentionName: cascade through link-bearing titles, cycle-guarded
 * (a diamond's second mention resolves; a true cycle folds to nothing at
 * the loop point). Not memoized — the store doesn't cache either.
 */
function mentionNameOf(ctx: EvalContext, targetId: string, path: Set<string>): string | null {
  if (path.has(targetId)) return null; // mention cycle: fold, never hang
  const target = ctx.client.getNode(targetId);
  if (target === undefined) return null;
  path.add(targetId);
  const name = deriveDisplayName(
    { id: targetId, contentAst: target.contentAst },
    undefined,
    (id) => mentionNameOf(ctx, id, path),
  );
  path.delete(targetId);
  return name === "" ? null : name;
}

/**
 * Content-derived plaintext — the port of the store's contentPlaintext:
 * the domain excerpt (mentions resolved through the client read) plus the
 * asset original names (quote/heading children walked, first name per
 * asset). The excerpt itself carries text runs, typed-link text, math,
 * and the recursive quote children.
 */
function contentPlaintextOf(ctx: EvalContext, node: ClientNode): string {
  const path = new Set<string>();
  const resolveMentionName = (targetId: string): string | null => mentionNameOf(ctx, targetId, path);
  const parts: string[] = [plainTextExcerpt(node.contentAst, undefined, resolveMentionName)];
  const seenAssets = new Set<string>();
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as { type?: unknown; assetId?: unknown; children?: unknown };
      if (t.type === "asset_ref" && typeof t.assetId === "string" && !seenAssets.has(t.assetId)) {
        seenAssets.add(t.assetId);
        const name = assetNameOf(ctx, t.assetId);
        if (name !== null) parts.push(name);
      } else if ((t.type === "quote" || t.type === "heading") && Array.isArray(t.children)) {
        walk(t.children);
      }
    }
  };
  walk(node.contentAst);
  return parts.filter((part) => part.length > 0).join(" ");
}

/**
 * Text-ish property values, one level deep — the port of the store's
 * propertyValuesPlaintext: AUTHORED visible rows only (derived binding
 * defaults do not index), a text carrier contributes the carrier's content
 * plaintext (one level — the carrier's own values do not ride along),
 * select/multi_select resolve to option labels (the raw id when the option
 * is gone), numbers index in string form.
 */
function propertyValuesPlaintextOf(ctx: EvalContext, node: ClientNode): string {
  const parts: string[] = [];
  for (const row of ctx.client.getEffectiveProperties(node.id)) {
    if (row.source !== "authored") continue;
    const schema = schemaOf(ctx, row.propertySchemaId);
    const type = schema?.type ?? row.schema?.type;
    if (type === "text") {
      const ref = refNodeIdOf(row.value);
      if (ref !== null) {
        const carrier = ctx.client.getNode(ref);
        if (carrier !== undefined) {
          const text = contentPlaintextOf(ctx, carrier);
          if (text) parts.push(text);
        }
      } else if (typeof row.value === "string" && row.value.length > 0) {
        parts.push(row.value);
      }
    } else if (type === "email") {
      if (typeof row.value === "string" && row.value.length > 0) parts.push(row.value);
    } else if (type === "number") {
      if (typeof row.value === "number" && Number.isFinite(row.value)) parts.push(String(row.value));
    } else if (type === "select" || type === "multi_select") {
      const ids = Array.isArray(row.value) ? row.value : [row.value];
      const options = schema?.options ?? [];
      for (const id of ids) {
        if (typeof id !== "string") continue;
        const option = options.find((entry) => entry.id === id);
        parts.push(option && option.label ? option.label : id);
      }
    }
  }
  return parts.join(" ");
}

/**
 * The derived search plaintext for one node — the port of
 * extractSearchPlaintext: content plaintext + text-ish property values,
 * whitespace-collapsed (the fold happens at comparison time, like the
 * store's index-time foldSearchText). Memoized per refinement.
 */
function searchPlaintextOf(ctx: EvalContext, node: ClientNode): string {
  let cached = ctx.plaintexts.get(node.id);
  if (cached === undefined) {
    cached = [contentPlaintextOf(ctx, node), propertyValuesPlaintextOf(ctx, node)]
      .filter((part) => part.length > 0)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    ctx.plaintexts.set(node.id, cached);
  }
  return cached;
}

/**
 * The ids-mode target list of a member condition (empty for the set bits;
 * the exact op's single id). A query/self target here is a planner bug —
 * the fail-loud guard throws (leafNeedsProbe flagged it for the probe).
 */
function memberIdsOf(condition: Extract<Condition, { type: "member" }>): string[] {
  switch (condition.op) {
    case "exists":
    case "not-exists":
      return [];
    case "exact":
      return condition.target.ids;
    default:
      return condition.target.mode === "ids" ? condition.target.ids : probeOnly(condition);
  }
}

/** Fail-loud guard: the sync arm never sees a query/self target (the plan flags it for the probe). */
function probeOnly(condition: { op: string; target?: { mode: string } }): never {
  throw new Error(
    `query resolve: a '${condition.target?.mode ?? "?"}' target requires the membership probe`,
  );
}

/** The strict-ancestor walk (self excluded), cycle-guarded — the parentPath/childPath ids predicate. */
function strictAncestorMatches(
  ctx: EvalContext,
  node: ClientNode,
  hit: (id: string) => boolean,
): boolean {
  const seen = new Set<string>([node.id]);
  let current = node.parentId;
  while (current !== null && !seen.has(current)) {
    if (hit(current)) return true;
    seen.add(current);
    const parent = ctx.client.getNode(current);
    current = parent?.parentId ?? null;
  }
  return false;
}

/** At least one descendant at any depth below (cycle-guarded DFS over the direct-children read). */
function hasDescendant(ctx: EvalContext, node: ClientNode): boolean {
  const seen = new Set<string>([node.id]);
  const stack = ctx.client.getChildren(node.id).map((child) => child.id);
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const child = ctx.client.getNode(current);
    if (child === undefined) continue;
    if (child.isActive) return true;
    for (const grandchild of ctx.client.getChildren(child.id)) {
      if (!seen.has(grandchild.id)) stack.push(grandchild.id);
    }
  }
  return false;
}

/**
 * The v2 condition evaluation over the materialized row — the sync arm of
 * the one-evaluation ruling. The member families evaluate their ids-mode
 * predicate (and the set bits) directly; the links/referencePath families
 * and the query/self target modes never arrive here (leafNeedsProbe flags
 * them for the probe path — the default arm fails loud if one does). The
 * `not-in` / `not-exists` ops negate the family's positive predicate, the
 * compiler's NOT(...) semantics.
 */
function conditionMatches(ctx: EvalContext, condition: QueryAst["root"]["children"][number], item: NodeCollectionItem): boolean {
  const node = item.node;
  switch (condition.type) {
    case "member": {
      // The sync-evaluable member arms: the ids-mode membership predicate
      // and the set bits, per family. A query/self target (or a
      // links/referencePath family) reaching here is a planner bug — loud.
      const negated = condition.op === "not-in" || condition.op === "not-exists";
      // The op classification via true branches (the multi-literal member
      // ops discriminate reliably only in the switch inside memberIdsOf) —
      // `ids` is the ids-mode target list (empty for the set bits).
      const ids = memberIdsOf(condition);
      const isSet = condition.op === "exists" || condition.op === "not-exists";
      const isExact = condition.op === "exact";
      let matched: boolean;
      switch (condition.family) {
        case "class": {
          if (isExact) {
            // EXACT set equality: exactly one class rides the row and it is
            // the picked one — no closure.
            matched = node.classIds.length === 1 && node.classIds[0] === ids[0];
            break;
          }
          if (isSet) {
            matched = node.classIds.length > 0;
            break;
          }
          matched = ids.some((classId) => classedWith(ctx, node, classId));
          break;
        }
        case "tags":
          matched = isSet
            ? node.tagIds.length > 0
            : ids.some((tagId) => node.tagIds.includes(tagId));
          break;
        case "parent":
          matched = isSet
            ? node.parentId !== null
            : node.parentId !== null && ids.includes(node.parentId);
          break;
        case "parentPath":
          // The parentPath set bit reads "has a parent" (the parent's).
          matched = isSet
            ? node.parentId !== null
            : strictAncestorMatches(ctx, node, (id) => ids.includes(id));
          break;
        case "child":
          matched = isSet
            ? ctx.client.getChildren(node.id).length > 0
            : ctx.client.getChildren(node.id).some((child) => ids.includes(child.id));
          break;
        case "childPath":
          // The set bit: at least one descendant at any depth below
          // (cycle-guarded DFS); the membership: a strict ancestor is picked.
          matched = isSet
            ? hasDescendant(ctx, node)
            : strictAncestorMatches(ctx, node, (id) => ids.includes(id));
          break;
        case "page":
          if (isSet) {
            const page = containingPageOf(ctx, node);
            matched = page !== undefined && page.id !== node.id;
          } else {
            const page = containingPageOf(ctx, node);
            matched = page !== undefined && ids.includes(page.id);
          }
          break;
        case "root": {
          // The root walk: the workspace-root ancestor (a parentless row is
          // its own root) is one of the picked nodes.
          const seen = new Set<string>([node.id]);
          let current: ClientNode | undefined = node;
          while (current.parentId !== null && !seen.has(current.parentId)) {
            const parent = ctx.client.getNode(current.parentId);
            if (parent === undefined) break;
            seen.add(parent.id);
            current = parent;
          }
          matched = ids.includes(current.id);
          break;
        }
        case "links":
        case "referencePath":
          // The edge-table families ride the probe path by plan — never here.
          throw new Error(
            `query resolve: the '${condition.family}' family requires the membership probe`,
          );
      }
      return negated ? !matched : matched;
    }
    case "content": {
      // The compiler's contentSql predicates run over the derived search
      // plaintext (the FTS row) — the full port above, diacritic-folded like
      // the index. A node with no plaintext has no search row: SQL NULL
      // semantics — every value op misses (content fts rides the probe path,
      // leafNeedsProbe flags it before this arm runs).
      const plaintext = foldSearchText(searchPlaintextOf(ctx, node));
      if (plaintext === "") return false;
      if (condition.op === "exists") return true;
      const text = asciiLower(plaintext);
      const bound = asciiLower(condition.value ?? "");
      switch (condition.op) {
        case "eq":
          return text === bound;
        case "neq":
          return text !== bound;
        case "starts":
          return text.startsWith(bound);
        case "ends":
          return text.endsWith(bound);
        default:
          return text.includes(bound);
      }
    }
    case "name": {
      // The title register — title-only (the compiler's nameSql reads the
      // raw text-run concatenation, deliberately NOT the search plaintext).
      if (condition.op === "exists") {
        return titleTextOf(node) !== "";
      }
      const text = asciiLower(titleTextOf(node));
      const bound = asciiLower(condition.value ?? "");
      switch (condition.op) {
        case "eq":
          return text === bound;
        case "neq":
          return text !== bound;
        default:
          return text.includes(bound);
      }
    }
    case "date": {
      const column = condition.field === "created" ? node.createdAt : node.updatedAt;
      switch (condition.op) {
        case "eq":
        case "neq":
        case "gt":
        case "gte":
        case "lt":
        case "lte":
          return condition.timestamp !== undefined &&
            dateCmpMatches(column, condition.op, condition.timestamp);
        case "after":
        case "before": {
          if (condition.timestamp === undefined) return false;
          const key = `${condition.field}:${condition.op}:${condition.timestamp}`;
          let bound = ctx.bounds.get(key);
          if (bound === undefined) {
            bound = resolveTimestampPlaceholder(condition.timestamp, condition.op);
            ctx.bounds.set(key, bound);
          }
          if (column === null) return false;
          return condition.op === "after" ? column >= bound : column <= bound;
        }
        case "between":
          return condition.from !== undefined &&
            condition.to !== undefined &&
            column !== null &&
            column >= resolveTimestampPlaceholder(condition.from, "after") &&
            column <= resolveTimestampPlaceholder(condition.to, "before");
        case "within": {
          if (column === null || condition.period === undefined) return false;
          const bounds = resolvePeriodBounds(condition.period);
          return column >= bounds.from && column <= bounds.to;
        }
        default:
          return false;
      }
    }
    case "property": {
      // The one-evaluation ruling: property conditions evaluate
      // synchronously over the effective-values read model — the same read
      // the compiler's property arm makes in the derived store. The between/
      // within ops fold the v1 range/period shapes into the parameterized op.
      if (condition.op === "between") {
        if (condition.from === undefined || condition.to === undefined) return false;
        const rows = ctx.client
          .getEffectiveProperties(node.id)
          .filter((row) => row.propertySchemaId === condition.schemaId);
        return rows.some(
          (row) =>
            valueMatches(row.value, "gte", condition.from) &&
            valueMatches(row.value, "lte", condition.to),
        );
      }
      if (condition.op === "within") {
        const rows = ctx.client
          .getEffectiveProperties(node.id)
          .filter((row) => row.propertySchemaId === condition.schemaId);
        const token = `{${condition.period}}`;
        const fromIso = placeholderStartDate(token);
        const toIso = placeholderEndDate(token);
        if (fromIso === null || toIso === null) return false;
        return rows.some((row) => {
          const refId = refNodeIdOf(row.value);
          if (refId !== null) {
            return (
              dateRefOrder(refId, "gte", fromIso) &&
              dateRefOrder(refId, "lte", toIso)
            );
          }
          return (
            typeof row.value === "string" && row.value >= fromIso && row.value <= toIso
          );
        });
      }
      return propertyMatches(ctx, node.id, condition);
    }
    case "nodeField": {
      if (condition.field === "isClass") return node.isClass === (condition.value !== "false");
      if (condition.field === "isEmbedded") return node.isEmbedded === (condition.value !== "false");
      return wireFieldMatches(node, condition.field, condition.op, condition.value);
    }
    default:
      // Joined-metadata leaves — the probe path evaluates these; the sync
      // path never reaches here (planSectionView flagged needsProbe).
      throw new Error(`query resolve: condition '${(condition as { type: string }).type}' requires the membership probe`);
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
  const ctx: EvalContext = { client, closures: new Map(), bounds: new Map(), assetNames: new Map(), plaintexts: new Map(), schemas: null };
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
    case "isEmbedded":
      return item.node.isEmbedded ? 1 : 0;
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
  base: {
    items: NodeCollectionItem[];
    groups: CollectionGroup[] | undefined;
    ungrouped?: NodeCollectionItem[] | undefined;
  },
  plan: SectionViewPlan,
): { items: NodeCollectionItem[]; groups: CollectionGroup[] | undefined; ungrouped: NodeCollectionItem[] | undefined } {
  if (plan.ast.root.children.length === 0 && (plan.ast.sort === undefined || plan.ast.sort.length === 0)) {
    return { items: base.items, groups: base.groups, ungrouped: base.ungrouped };
  }
  const ctx: EvalContext = { client, closures: new Map(), bounds: new Map(), assetNames: new Map(), plaintexts: new Map(), schemas: null };
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
  // The ungrouped rows refine like the groups' rows: filtered by the same
  // predicate, keeping their container's order (the groups' precedent).
  const ungrouped =
    base.ungrouped === undefined
      ? undefined
      : allKept(base.ungrouped)
        ? base.ungrouped
        : filterItems(ctx, plan.ast, base.ungrouped);
  if (plan.ast.sort !== undefined && plan.ast.sort.length > 0) {
    // Groups keep their container's order — a grouped view sorts within the
    // refinement only when the caller renders flat rows.
    return { items: [...items].sort(compareBySort(plan.ast.sort)), groups, ungrouped };
  }
  return { items, groups, ungrouped };
}

/**
 * The probe path (joined-metadata leaves): one membership query per probe
 * leaf through the established runQueryAst channel, intersected with the
 * base set. Returns the resolved rows. `selfNodeId` is the hosting page the
 * `self` target modes resolve against (absent only when the plan has no Self
 * leaves — the compiler fails loud otherwise).
 */
export async function resolveSectionViewProbed(
  client: SectionViewResolveClient,
  base: {
    items: NodeCollectionItem[];
    groups: CollectionGroup[] | undefined;
    ungrouped?: NodeCollectionItem[] | undefined;
  },
  plan: SectionViewPlan,
  selfNodeId?: string,
): Promise<{ items: NodeCollectionItem[]; groups: CollectionGroup[] | undefined; ungrouped: NodeCollectionItem[] | undefined }> {
  const probes = new Map<string, Set<string>>();
  const probeFor = async (condition: QueryAst["root"]["children"][number]): Promise<Set<string>> => {
    const key = JSON.stringify(condition);
    const existing = probes.get(key);
    if (existing !== undefined) return existing;
    const result = await Promise.resolve(
      client.runQueryAst({
        version: 2,
        scope: { type: "entire_workspace" },
        root: { type: "group", logic: "and", children: [condition] },
      }, { selfNodeId }),
    );
    const ids = new Set(result.ids.map(String));
    probes.set(key, ids);
    return ids;
  };

  const ctx: EvalContext = { client, closures: new Map(), bounds: new Map(), assetNames: new Map(), plaintexts: new Map(), schemas: null };
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
  // The ungrouped rows refine like the groups' rows (the sync path's rule).
  const ungrouped =
    base.ungrouped === undefined
      ? undefined
      : (
          await Promise.all(
            base.ungrouped.map(async (item) =>
              (await matches({ type: "group", logic: plan.ast.root.logic, children: plan.ast.root.children }, item)) ? item : null,
            ),
          )
        ).filter((item): item is NodeCollectionItem => item !== null);
  if (plan.ast.sort !== undefined && plan.ast.sort.length > 0) {
    items = [...items].sort(compareBySort(plan.ast.sort));
  }
  return { items, groups, ungrouped };
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
  ungrouped: NodeCollectionItem[] | undefined,
  view: { id: string; queryAst: unknown } | null | undefined,
  selfNodeId?: string,
): SectionViewResolution {
  const [probed, setProbed] = useState<{ key: string; items?: NodeCollectionItem[]; groups?: CollectionGroup[] | undefined; ungrouped?: NodeCollectionItem[] | undefined; error?: string } | null>(null);
  const [version, setVersion] = useState(0);

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

  const base: SectionViewResolution = { items, groups, ungrouped, error: null };
  const needsProbe = plan !== null && !("error" in plan) && plan.needsProbe;
  // The notification version only feeds the probe path's re-probe signature.
  // Non-probe collections (every default view, incl. the page body) subscribe
  // to nothing — an unconditional subscription re-rendered the whole
  // collection on every client notification (op-lag slice 4).
  useEffect(() => {
    if (!needsProbe) return;
    return client.subscribe(() => setVersion((v) => v + 1));
  }, [client, needsProbe]);
  const signature = needsProbe
    ? `${astKey}|${items.map((item) => item.node.id).join(",")}|${(groups ?? []).map((group) => group.id).join(",")}|${version}|${selfNodeId ?? ""}`
    : "";

  useEffect(() => {
    if (!needsProbe || plan === null || "error" in plan) return;
    let cancelled = false;
    void resolveSectionViewProbed(client, { items, groups, ungrouped }, plan, selfNodeId)
      .then((result) => {
        if (!cancelled) setProbed({ key: signature, items: result.items, groups: result.groups, ungrouped: result.ungrouped });
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
      return { ...applySectionView(client, { items, groups, ungrouped }, plan), error: null };
    } catch (error) {
      return { ...base, error: errorMessage(error) };
    }
  }
  if (probed === null || probed.key !== signature) return base; // first probe still running
  if (probed.error !== undefined) return { ...base, error: probed.error };
  return { items: probed.items ?? items, groups: probed.groups, ungrouped: probed.ungrouped, error: null };
}
