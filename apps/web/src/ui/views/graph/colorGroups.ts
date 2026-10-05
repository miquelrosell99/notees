/**
 * colorGroups.ts — QueryAST color groups (the parked §34.80 follow-up, the
 * v1 GraphGroupModal/evaluateQueryAST design): each group is a query in the
 * text DSL (`class:book prop:read:` …) plus a color; nodes matching a group
 * render in the group's color. First match wins; a node with no group keeps
 * its own color. Evaluation rides the client's own query runner and the
 * workspace resolvers, so groups see exactly what the query surfaces see.
 * Pure evaluation — the UI panel and persistence live in GraphView.
 */

import { parseQueryLanguage, type QueryLanguageResolvers } from "@notees/query";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

export interface GraphColorGroup {
  id: string;
  label: string;
  /** Preset token or #RRGGBB (the §34.43 grammar). */
  color: string;
  /** The text DSL query selecting the group's nodes. */
  query: string;
}

type AnyDataClient = WorkspaceClient | WorkerClient;

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
 * Evaluate the groups in order — returns nodeId → resolved css color for the
 * FIRST group each node matches. Invalid queries are skipped (the panel
 * surfaces the parse error); an empty/whitespace query matches nothing.
 * Async because the worker client's query runner is async.
 */
export async function evaluateColorGroups(
  client: AnyDataClient,
  groups: GraphColorGroup[],
  resolveCss: (color: string) => string,
): Promise<Map<string, string>> {
  const assignment = new Map<string, string>();
  const resolvers = resolversFor(client);
  for (const group of groups) {
    if (group.query.trim() === "") continue;
    let ast: unknown;
    try {
      ast = parseQueryLanguage(group.query, { resolvers });
    } catch {
      continue;
    }
    let ids: string[];
    try {
      ids = (await Promise.resolve(client.runQueryAst(ast))).ids;
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

/** Validate a group's query text (the panel's honest error row). */
export function colorGroupError(client: AnyDataClient, query: string): string | null {
  if (query.trim() === "") return null;
  try {
    parseQueryLanguage(query, { resolvers: resolversFor(client) });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
