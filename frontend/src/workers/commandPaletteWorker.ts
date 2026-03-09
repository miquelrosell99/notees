/**
 * Command Palette Search Worker
 *
 * Runs categorization and breadcrumb building off the main thread so
 * the UI never freezes while processing large search results.
 *
 * Uses O(1) Map-based parent lookups instead of the old O(n) Array.find().
 */

import { parseAST } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';

// ─── Minimal local types (avoids importing React-dependent modules) ──

interface NodeSlim {
  id: number;
  name: string;
  parent_id: number | null;
  page_id: number | null;
  is_page: boolean;
}

interface PropertySlim {
  id: number;
  name: string;
  icon?: string | null;
}

export interface WorkerRequest {
  /** Sequence ID — response with a different ID should be discarded. */
  id: number;
  nodes: NodeSlim[];
  properties: PropertySlim[];
  searchTerm: string;
}

export interface WorkerPageResult {
  nodeId: number;
  breadcrumb?: string;
}

export interface WorkerBlockResult {
  nodeId: number;
  breadcrumb: string;
}

export interface WorkerPropertyResult {
  propertyId: number;
}

export interface WorkerResponse {
  id: number;
  pages: WorkerPageResult[];
  blocks: WorkerBlockResult[];
  properties: WorkerPropertyResult[];
}

// ─── Helpers ──────────────────────────────────────────────────────

function nameToText(nameJson: string): string {
  try {
    const ast = parseAST(nameJson);
    return stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY });
  } catch {
    return '';
  }
}

function buildBreadcrumb(
  node: NodeSlim,
  nodeMap: Map<number, NodeSlim>,
): string {
  const parts: string[] = [];
  let current: NodeSlim | undefined = node;

  // Walk up the parent chain (O(depth) with Map lookups)
  while (current?.parent_id != null) {
    const parent = nodeMap.get(current.parent_id);
    if (parent) {
      parts.unshift(nameToText(parent.name) || 'Untitled');
      current = parent;
    } else {
      break;
    }
  }

  // If node has a page_id different from parent, prepend page name
  if (node.page_id != null && node.page_id !== node.parent_id) {
    const page = nodeMap.get(node.page_id);
    if (page) {
      const pageName = nameToText(page.name) || 'Untitled';
      if (!parts.includes(pageName)) {
        parts.unshift(pageName);
      }
    }
  }

  return parts.join(' > ');
}

// ─── Main handler ─────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, nodes, properties, searchTerm } = e.data;

  // Build O(1) lookup map
  const nodeMap = new Map<number, NodeSlim>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const pages: WorkerPageResult[] = [];
  const blocks: WorkerBlockResult[] = [];

  for (const node of nodes) {
    if (node.is_page) {
      // It's a page — compute breadcrumb if it has a parent
      const breadcrumb = node.parent_id !== null ? buildBreadcrumb(node, nodeMap) : undefined;
      pages.push({ nodeId: node.id, breadcrumb });
    } else {
      // It's a block — compute breadcrumb
      const breadcrumb = buildBreadcrumb(node, nodeMap);
      blocks.push({ nodeId: node.id, breadcrumb });
    }
  }

  // Filter properties client-side (server doesn't search them)
  const matchedProperties: WorkerPropertyResult[] = [];
  if (searchTerm.trim()) {
    const lowerQuery = searchTerm.toLowerCase();
    for (const prop of properties) {
      if (prop.name.toLowerCase().includes(lowerQuery)) {
        matchedProperties.push({ propertyId: prop.id });
      }
    }
  }

  const response: WorkerResponse = {
    id,
    pages,
    blocks,
    properties: matchedProperties,
  };

  self.postMessage(response);
};
