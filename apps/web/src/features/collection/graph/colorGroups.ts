/**
 * colorGroups.ts — QueryAST color groups: each group is a query AST root
 * group (the FilterBlockBuilder's grammar — class/type/content/property/
 * link conditions) plus a color; nodes matching a group render in the
 * group's color. The persisted list order IS the first-match-wins priority;
 * a node with no group keeps its own color. Evaluation wraps the group in
 * the workspace-scope AST and rides the client's own query runner, so
 * groups see exactly what the query surfaces see. Pure evaluation — the
 * rail panel and persistence live in GraphView.
 *
 * Persistence is the AST itself (JSON-serializable). Two one-time device
 * migrations run at load (`migrateColorGroup`, the GraphView effect's
 * precedent): the pre-AST stores held a text-DSL `query` string per group
 * (parsed through the DSL, names resolved against the workspace), and the
 * v1-era stores hold a v1 query AST per group (rewritten through the pure
 * v1→v2 mapping — no dual-parse anywhere). Fail-loud errors keep the group
 * but mark it erroneous, painted nowhere.
 */

import {
  parseQueryLanguage,
  type Child,
  type Group,
  type QueryAst,
  type QueryLanguageResolvers,
} from "@notees/query";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";
import {
  isQueryAstV1,
  mapQueryAstV1ToV2,
} from "../../../../../../scripts/lib/map-query-ast-v1-v2.js";

export interface GraphColorGroup {
  id: string;
  label: string;
  /** Preset token or #RRGGBB. */
  color: string;
  /** The query AST root group selecting the group's nodes (builder-edited). */
  ast: Group | null;
  /** Set when a legacy DSL string failed to migrate — the group stays listed, painted nowhere. */
  error?: string | undefined;
}

/** The retired pre-AST wire shape (a text-DSL query string), still read at load. */
export interface LegacyGraphColorGroup {
  id: string;
  label: string;
  color: string;
  /** The retired text-DSL query selecting the group's nodes. */
  query: string;
}

/** The stored union — device stores may still hold legacy rows. */
export type StoredColorGroup = GraphColorGroup | LegacyGraphColorGroup;

type AnyDataClient = WorkspaceClient | WorkerClient;

/** True when a stored row is a pre-AST legacy group (a `query` string, no AST). */
export function isLegacyColorGroup(group: unknown): group is LegacyGraphColorGroup {
  return (
    typeof group === "object" &&
    group !== null &&
    "query" in group &&
    typeof (group as { query: unknown }).query === "string"
  );
}

/** Workspace-backed resolvers: class/property-schema/node names resolve. */
function resolversFor(client: AnyDataClient): QueryLanguageResolvers {
  return {
    resolveClass: (name) =>
      client
        .listClasses()
        .find((klass) => (klass.name ?? "").toLowerCase() === name.toLowerCase())?.id,
    resolvePropertySchema: (name) =>
      client
        .listPropertySchemas()
        .find((schema) => schema.name.toLowerCase() === name.toLowerCase())?.id,
    resolveNode: (name) => client.resolveNodeByName(name) ?? undefined,
  };
}

/** The v2 condition types — a stored group tree is v2 when every condition rides one. */
const V2_CONDITION_TYPES = new Set(["member", "content", "name", "property", "date", "nodeField"]);

/** Recursive walk: true when every condition in the tree is a v2 shape. */
function isV2ConditionTree(children: Child[]): boolean {
  for (const child of children) {
    if (child.type === "group") {
      if (!isV2ConditionTree(child.children)) return false;
    } else if (child.type === "not") {
      if (child.child.type === "group") {
        if (!isV2ConditionTree(child.child.children)) return false;
      } else if (!V2_CONDITION_TYPES.has(child.child.type)) {
        return false;
      }
    } else if (!V2_CONDITION_TYPES.has(child.type)) {
      return false;
    }
  }
  return true;
}

/**
 * The one-time legacy migrations, run per device at load. A text-DSL string
 * parses through the DSL parser (names resolve against the workspace) and
 * the group re-persists as an AST. A stored v1 AST rewrites through the
 * pure v1→v2 mapping (`{version: 1}` envelope → mapped root). A fail-loud
 * error KEEPS the group but marks it erroneous (`ast: null` + the message)
 * — the same honesty the old live `colorGroupError` row had.
 * Already-migrated (v2) rows pass through.
 */
export function migrateColorGroup(client: AnyDataClient, group: unknown): GraphColorGroup {
  if (isLegacyColorGroup(group)) {
    const { id, label, color } = group;
    try {
      const parsed = parseQueryLanguage(group.query, { resolvers: resolversFor(client) });
      return { id, label, color, ast: parsed.root };
    } catch (error) {
      return {
        id,
        label,
        color,
        ast: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const stored = group as GraphColorGroup;
  if (stored.ast !== null && !isV2ConditionTree(stored.ast.children)) {
    try {
      const envelope = {
        version: 1,
        scope: { type: "entire_workspace" },
        root: stored.ast,
      };
      if (!isQueryAstV1(envelope)) throw new Error("not a v1 query AST");
      const mapped = mapQueryAstV1ToV2(envelope) as { root: Group };
      return { ...stored, ast: mapped.root };
    } catch (error) {
      return {
        ...stored,
        ast: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return stored;
}

/** Wrap a group's root in the workspace-scope AST the query runner consumes. */
export function colorGroupQueryAst(root: Group): QueryAst {
  return { version: 2, scope: { type: "entire_workspace" }, root };
}

/**
 * Evaluate the groups in list order — returns nodeId → resolved css color for
 * the FIRST group each node matches (the list order IS the priority; the
 * panel's drag-reorder rewrites it). Erroneous (unmigrated) groups and empty
 * groups match nothing; a runner failure skips that group. Async because the
 * worker client's query runner is async. `selfNodeId` is the hosting page
 * the `self` target modes resolve against.
 */
export async function evaluateColorGroups(
  client: AnyDataClient,
  groups: GraphColorGroup[],
  resolveCss: (color: string) => string,
  selfNodeId?: string,
): Promise<Map<string, string>> {
  const assignment = new Map<string, string>();
  for (const group of groups) {
    // `ast == null` covers the unmigrated-legacy first frame (undefined
    // until the one-time migration effect lands) and the erroneous row.
    if (group.ast == null || group.ast.children.length === 0) continue;
    let ids: string[];
    try {
      ids = (await Promise.resolve(client.runQueryAst(colorGroupQueryAst(group.ast), { selfNodeId }))).ids;
    } catch {
      continue;
    }
    const css = resolveCss(group.color);
    for (const id of ids) {
      if (!assignment.has(id)) assignment.set(id, css);
    }
  }
  return assignment;
}
