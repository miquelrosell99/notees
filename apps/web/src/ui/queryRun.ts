/**
 * queryRun — the live AST execution hook + result helpers shared by
 * QueryBlockView (the token's inline view) and the Queries hub (the
 * section-scale saved-views surface).
 *
 * Coalesced live re-runs: the query re-runs when the AST or the
 * store version changes, but a run in flight marks intervening notifications
 * dirty and schedules exactly ONE trailing run, so a notification burst costs
 * at most two executions instead of one per envelope; a run whose (AST,
 * version) pair is already the latest is skipped outright. The last result
 * caches between runs.
 */

import { useEffect, useRef, useState } from "react";

import { parseQueryAst, type QueryAst } from "@notees/query";

import { rendersAsInlineBlock, rendersWithDocumentChrome } from "@notees/domain";

import type { NodeCollectionItem, TableColumn } from "../features/collection/index.js";
import { parentlessBlockResolverOf } from "./renderStateLabel.js";
import type {
  ClientNode,
  QueryAggregateResult,
  QueryRunResult,
  QueryRunSummary,
} from "@/core/workspace-client/index.js";

/** The result of a live run: a plain query's id set, or an aggregation's grid. */
export type QueryRunState =
  | ({ kind: "query" } & QueryRunResult)
  | { kind: "aggregate"; dimensionCount: number } & QueryAggregateResult;

/** The run bridge both client classes satisfy (OutlinerReader declares it too). */
export interface QueryRunClient {
  runQueryAst(rawAst: unknown): QueryRunResult | Promise<QueryRunResult>;
  runAggregateAst(rawAst: unknown): QueryAggregateResult | Promise<QueryAggregateResult>;
  /** The notify subscription the coalesced re-run rides. */
  subscribe(listener: () => void): () => void;
  getNode(id: string): { id: string; parentId: string | null } | undefined;
  /** The parentlessRole "block" demote resolver for the role predicates. */
  effectiveClassParentlessBlock(classId: string): boolean;
}

/** Loose-token parse for the render path: invalid ASTs surface as the error. */
export function parseRunAst(raw: unknown): QueryAst | null {
  try {
    return parseQueryAst(raw);
  } catch {
    return null;
  }
}

export function useQueryRun(client: QueryRunClient, rawAst: unknown): {
  result: QueryRunState | null;
  error: string | null;
} {
  const [result, setResult] = useState<QueryRunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const status = useRef<{ running: boolean; dirty: boolean; astKey: string | null; version: number }>({
    running: false,
    dirty: false,
    astKey: null,
    version: -1,
  });

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const astKey = JSON.stringify(rawAst ?? null);
  useEffect(() => {
    const current = status.current;
    if (current.astKey === astKey && current.version === version) return; // already current
    const execute = async () => {
      const runAstKey = astKey;
      const runVersion = version;
      current.running = true;
      try {
        const parsed = parseRunAst(rawAst);
        const next: QueryRunState =
          parsed !== null && parsed.aggregation !== undefined
            ? {
                kind: "aggregate",
                dimensionCount: parsed.aggregation.dimensions.length,
                ...(await Promise.resolve(client.runAggregateAst(rawAst))),
              }
            : { kind: "query", ...(await Promise.resolve(client.runQueryAst(rawAst))) };
        current.astKey = runAstKey;
        current.version = runVersion;
        setResult(next);
        setError(null);
      } catch (err) {
        current.astKey = runAstKey;
        current.version = runVersion;
        setResult(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        current.running = false;
        if (current.dirty) {
          // One trailing run for the notifications that landed mid-flight;
          // bumping the version re-arms this effect with a fresh pair.
          current.dirty = false;
          setVersion((v) => v + 1);
        }
      }
    };
    if (current.running) {
      current.dirty = true;
      return;
    }
    void execute();
  }, [client, astKey, version]);

  return { result, error };
}

/** The query result's table columns (aligned with the view registry's table). */
export const QUERY_TABLE_COLUMNS: TableColumn[] = [
  { id: "name", kind: "name", label: "Name", sortable: true },
  { id: "isClass", kind: "isClass", label: "Class", sortable: true },
  { id: "isEmbedded", kind: "isEmbedded", label: "Embedded", sortable: true },
  { id: "created", kind: "created", label: "Created", sortable: true },
];

/** Query run rows → the collection input shape (unresolvable rows drop out). */
export function queryResultItems(
  client: { getNode(id: string): ClientNode | undefined },
  rows: QueryRunSummary[],
  limit: number,
): NodeCollectionItem[] {
  const items: NodeCollectionItem[] = [];
  for (const row of rows.slice(0, limit)) {
    const node = client.getNode(row.id);
    if (node !== undefined) items.push({ node });
  }
  return items;
}

/**
 * Render-cascade navigation for a query result row: document-chrome nodes
 * (pages, classes) open directly; an inline block resolves to its containing
 * main node (nearest document-chrome ancestor).
 */
export function openQueryResult(
  client: QueryRunClient,
  row: QueryRunSummary,
  onOpenNode: ((nodeId: string) => void) | undefined,
): void {
  if (onOpenNode === undefined) return;
  const parentlessBlock = parentlessBlockResolverOf(client);
  if (!rendersAsInlineBlock(row, client.getNode(row.parentId ?? ""), parentlessBlock)) {
    onOpenNode(row.id);
    return;
  }
  // Ancestor walk with the parent-page condition: a bit under a non-page
  // parent is inert, so the walk continues past it to the real page.
  const seen = new Set<string>([row.id]);
  let current = client.getNode(row.parentId ?? "");
  let currentParent =
    current !== undefined && current.parentId !== null ? client.getNode(current.parentId) : undefined;
  while (
    current !== undefined &&
    !rendersWithDocumentChrome(current, currentParent, parentlessBlock) &&
    !seen.has(current.id)
  ) {
    seen.add(current.id);
    current = currentParent;
    currentParent =
      current !== undefined && current.parentId !== null ? client.getNode(current.parentId) : undefined;
  }
  onOpenNode(
    current !== undefined && rendersWithDocumentChrome(current, currentParent, parentlessBlock)
      ? current.id
      : row.id,
  );
}
