/**
 * useRuntimeSync — Hook to sync backend API data with NodeGraphRuntime.
 *
 * Bridges TanStack Query (server state) with NodeGraphRuntime (client state).
 * Converts API Node objects to GraphNode format and loads them into the runtime.
 */

import { useEffect } from 'react';
import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import type { GraphNode, GraphNodeType, ContentAST } from '../runtime/types';
import type { Node } from '../types/api';

/**
 * Convert an API Node to a GraphNode for the runtime.
 */
export function apiNodeToGraphNode(node: Node): GraphNode {
  return {
    blockId: node.uuid,
    serverId: node.id,
    parentId: node.parent_id ? String(node.parent_id) : null,
    orderIndex: node.sequence ?? 0,
    nodeType: inferNodeType(node),
    contentAST: parseContentToAST(node.name || ''),
    collapsed: node.collapsed ?? false,
    isDeleted: node.is_deleted ?? false,
    isPage: node.is_page ?? false,
    name: extractPlainName(node.name || ''),
    icon: node.icon || null,
    color: node.color || null,
    classIds: (node.classes || []).map(String),
    tagIds: (node.tags || []).map(String),
    createdAt: node.create_date || new Date().toISOString(),
    updatedAt: node.write_date || new Date().toISOString(),
    version: 1,
  };
}

function inferNodeType(node: Node): GraphNodeType {
  if (node.is_page) return 'page';
  if (node.is_daily) return 'day';
  if (node.is_monthly) return 'month';
  if (node.is_yearly) return 'year';
  // Check classes for special types
  const classes = node.classes || [];
  for (const cls of classes) {
    const name = typeof cls === 'string' ? cls : String(cls);
    if (name.includes('query')) return 'query';
    if (name.includes('table')) return 'table';
    if (name.includes('code')) return 'code';
    if (name.includes('asset')) return 'asset';
    if (name.includes('card')) return 'card';
    if (name.includes('template')) return 'template';
    if (name.includes('comment')) return 'comment';
  }
  return 'block';
}

function parseContentToAST(content: string): ContentAST {
  // Try to parse as JSON AST first
  if (content.startsWith('[')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type === 'paragraph') {
        return parsed;
      }
    } catch {
      // Not valid JSON, treat as plain text
    }
  }

  // Plain text → single paragraph
  return [{
    type: 'paragraph',
    children: [{ type: 'text', text: content }],
  }];
}

function extractPlainName(content: string): string {
  // Strip [[links]] and {{types}} for display
  return content
    .replace(/\[\[([^\]]*?)\]\]/g, (_, inner) => {
      const parts = inner.split(':');
      return parts[0] || inner;
    })
    .replace(/\{\{([^}]*?)\}\}/g, '')
    .trim();
}

/**
 * Hook: Sync API nodes into the runtime when they change.
 */
export function useRuntimeSync(nodes: Node[] | undefined, isLoading: boolean): void {
  useEffect(() => {
    if (!nodes || isLoading) return;

    const runtime = getNodeGraphRuntime();
    const graphNodes = nodes.map(apiNodeToGraphNode);
    runtime.upsertNodes(graphNodes);
  }, [nodes, isLoading]);
}

/**
 * Hook: Sync a single page and its children into the runtime.
 */
export function useRuntimePageSync(
  page: Node | undefined,
  children: Node[] | undefined,
  isLoading: boolean,
): void {
  useEffect(() => {
    if (!page || isLoading) return;

    const runtime = getNodeGraphRuntime();
    const graphNodes: GraphNode[] = [apiNodeToGraphNode(page)];

    if (children) {
      for (const child of children) {
        graphNodes.push(apiNodeToGraphNode(child));
      }
    }

    runtime.upsertNodes(graphNodes);
  }, [page, children, isLoading]);
}
