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
 * Persistence is the AST itself (JSON-serializable). The pre-AST device
 * stores held a text-DSL `query` string per group; `migrateColorGroup`
 * performs the one-time in-place interpretation at load (fail-loud parse
 * errors keep the group but mark it erroneous, painted nowhere).
 */

import {
  parseQueryLanguage,
  type Group,
  type QueryAst,
  type QueryLanguageResolvers,
} from "@notees/query";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

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

/**
 * The one-time legacy migration, run per device at load: a text-DSL string
 * parses through the DSL parser (names resolve against the workspace) and
 * the group re-persists as an AST. A fail-loud parse error KEEPS the group
 * but marks it erroneous (`ast: null` + the message) — the same honesty the
 * old live `colorGroupError` row had. Already-migrated rows pass through.
 */
export function migrateColorGroup(client: AnyDataClient, group: unknown): GraphColorGroup {
  if (!isLegacyColorGroup(group)) return group as GraphColorGroup;
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

/** Wrap a group's root in the workspace-scope AST the query runner consumes. */
export function colorGroupQueryAst(root: Group): QueryAst {
  return { version: 1, scope: { type: "entire_workspace" }, root };
}

/**
 * Evaluate the groups in list order — returns nodeId → resolved css color for
 * the FIRST group each node matches (the list order IS the priority; the
 * panel's drag-reorder rewrites it). Erroneous (unmigrated) groups and empty
 * groups match nothing; a runner failure skips that group. Async because the
 * worker client's query runner is async.
 */
export async function evaluateColorGroups(
  client: AnyDataClient,
  groups: GraphColorGroup[],
  resolveCss: (color: string) => string,
): Promise<Map<string, string>> {
  const assignment = new Map<string, string>();
  for (const group of groups) {
    // `ast == null` covers the unmigrated-legacy first frame (undefined
    // until the one-time migration effect lands) and the erroneous row.
    if (group.ast == null || group.ast.children.length === 0) continue;
    let ids: string[];
    try {
      ids = (await Promise.resolve(client.runQueryAst(colorGroupQueryAst(group.ast)))).ids;
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
