/**
 * Build BreadcrumbItemResponse-shaped results from the core SQLite derived store.
 */

import type { BreadcrumbItemResponse } from '@/types/api';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

const MAX_RESOLVED_NAME_LENGTH = 200;

/**
 * Resolve a node's content AST to plain text, expanding node links recursively.
 *
 * Links that cannot be resolved (deleted target, missing store entry) fall back
 * to the AST label or a placeholder. Recursive/cyclic links are rendered as "…"
 * by stringifyAST's built-in cycle detection.
 */
function resolveNameText(store: WorkspaceStore, content: string | null | undefined): string {
  if (!content) return '';
  const ast = parseAST(content);
  const text = stringifyAST(ast, {
    mode: StringifyMode.TEXT_ONLY,
    maxLength: MAX_RESOLVED_NAME_LENGTH,
    resolveNodeLink: (linkId) => {
      const { nodeUuid } = parseLinkId(linkId);
      if (!nodeUuid) return null;
      const target = projectNode(store, nodeUuid);
      if (!target) return null;
      return {
        targetAST: parseAST(target.content),
        label: null,
        targetId: nodeUuid,
      };
    },
  });
  return text.trim();
}

export function buildBreadcrumbs(store: WorkspaceStore, nodeUuid: string): BreadcrumbItemResponse[] {
  const breadcrumbs: BreadcrumbItemResponse[] = [];
  const visited = new Set<string>();
  let currentId: string | null | undefined = nodeUuid;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = projectNode(store, currentId);
    if (!node) break;

    currentId = node.parent_uuid;
    if (!currentId) break;

    const parent = projectNode(store, currentId);
    if (!parent) break;

    breadcrumbs.push({
      uuid: parent.uuid,
      name: parent.name,
      display_name: resolveNameText(store, parent.content) || parent.display_name || parent.name,
      icon: parent.icon ?? null,
      is_page: parent.is_page,
      parent_locked: parent.parent_locked ?? false,
    });
  }

  return breadcrumbs;
}

export async function buildBreadcrumbsFromClient(
  client: IWorkspaceStoreClient,
  nodeUuid: string
): Promise<BreadcrumbItemResponse[]> {
  return client.query<BreadcrumbItemResponse[]>('buildBreadcrumbs', [nodeUuid]);
}
