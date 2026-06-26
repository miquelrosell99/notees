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
  uuid: string;
  name: string;
  parent_uuid: string | null;
  page_uuid: string | null;
  is_page: boolean;
}

interface PropertySlim {
  uuid: string;
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
  uuid: string;
  breadcrumb?: string;
}

export interface WorkerBlockResult {
  uuid: string;
  breadcrumb: string;
}

export interface WorkerPropertyResult {
  uuid: string;
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
  nodeMap: Map<string, NodeSlim>,
): string {
  const parts: string[] = [];
  let current: NodeSlim | undefined = node;

  // Walk up the parent chain (O(depth) with Map lookups)
  while (current?.parent_uuid != null) {
    const parent = nodeMap.get(current.parent_uuid);
    if (parent) {
      parts.unshift(nameToText(parent.name) || 'Untitled');
      current = parent;
    } else {
      break;
    }
  }

  // If node has a page_uuid different from parent, prepend page name
  if (node.page_uuid != null && node.page_uuid !== node.parent_uuid) {
    const page = nodeMap.get(node.page_uuid);
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
  const nodeMap = new Map<string, NodeSlim>();
  for (const node of nodes) {
    nodeMap.set(node.uuid, node);
  }

  const pages: WorkerPageResult[] = [];
  const blocks: WorkerBlockResult[] = [];

  for (const node of nodes) {
    if (node.is_page) {
      // It's a page — compute breadcrumb if it has a parent
      const breadcrumb = node.parent_uuid !== null ? buildBreadcrumb(node, nodeMap) : undefined;
      pages.push({ uuid: node.uuid, breadcrumb });
    } else {
      // It's a block — compute breadcrumb
      const breadcrumb = buildBreadcrumb(node, nodeMap);
      blocks.push({ uuid: node.uuid, breadcrumb });
    }
  }

  // Filter properties client-side (server doesn't search them)
  const matchedProperties: WorkerPropertyResult[] = [];
  if (searchTerm.trim()) {
    const lowerQuery = searchTerm.toLowerCase();
    for (const prop of properties) {
      if (prop.name.toLowerCase().includes(lowerQuery)) {
        matchedProperties.push({ uuid: prop.uuid });
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
