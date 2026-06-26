/**
 * localQuery — offline query fallback for Milestone 5.
 *
 * Executes text search and (eventually) QueryAST filters against the local
 * node mirror and MiniSearch index. This module is the offline counterpart to
 * the server-side `/nodes/search` and QueryAST endpoints.
 */

import { searchIndex, type SearchFilters } from './searchIndex';
import { getNode, getAllNodes } from './localNodeStore';
import { buildLocalReferenceGraph } from './localReferenceGraph';
import { substituteRuntimeParams } from './substituteRuntimeParams';
import { buildEvalContext, evaluateQueryAST } from '@/features/views';
import type { QueryAST } from '@/types';
import type { Node } from '@/types/api';

const LOCAL_QUERY_RESULT_LIMIT = 500;

export interface LocalQueryFilters {
  ast?: QueryAST;
  runtimeParams?: Record<string, unknown>;
  parentId?: string | null;
  classIds?: string[];
  query?: string;
  isPage?: boolean;
  isClass?: boolean;
  isDaily?: boolean;
}

/**
 * Execute a query against the local state.
 *
 * - If `query` is provided, runs a MiniSearch full-text search and applies
 *   simple metadata filters (`isPage`, `isClass`, `isDaily`, `classIds`).
 * - If `ast` is provided, evaluates the QueryAST against the local node mirror.
 */
export async function queryNodesLocal(
  workspaceUuid: string,
  filters: LocalQueryFilters,
): Promise<Node[]> {
  const searchFilters: SearchFilters = {
    isPage: filters.isPage,
    isClass: filters.isClass,
    isDaily: filters.isDaily,
    classUuids: filters.classIds,
  };

  if (filters.ast) {
    const ast = substituteRuntimeParams(filters.ast, filters.runtimeParams ?? {});
    const nodes = await getAllNodes(workspaceUuid);
    const nodeByUuid = new Map(nodes.map((n) => [n.uuid, n]));
    const { nodes: graphNodes, links } = buildLocalReferenceGraph(nodes);
    const classNodes = nodes.filter((n) => n.is_class);
    const ctx = buildEvalContext(graphNodes, links, classNodes);

    const matches: Node[] = [];
    for (const graphNode of graphNodes) {
      if (evaluateQueryAST(ast, graphNode, ctx)) {
        const sourceNode = nodeByUuid.get(graphNode.uuid);
        if (sourceNode) {
          matches.push(sourceNode);
        }
      }
    }
    return matches.slice(0, LOCAL_QUERY_RESULT_LIMIT);
  }

  const results = await searchIndex(workspaceUuid, filters.query ?? '', searchFilters);
  const nodes: (Node | undefined)[] = await Promise.all(
    results.map((r) => getNode(workspaceUuid, r.id)),
  );
  return nodes.filter((n): n is Node => n !== undefined);
}
