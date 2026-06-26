/**
 * Build a local graph suitable for the client-side QueryAST evaluator.
 *
 * Converts mirrored Node objects into ApiGraphNode/GraphLink shapes and derives
 * parent, class, extends, and reference links from local data.
 */

import type { Node } from '@/types/api';
import type { GraphNode, GraphLink } from '@/api/nodes';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import type { ASTBlockNode, ASTInlineNode } from '@/types/ast';

export interface LocalReferenceGraph {
  nodes: GraphNode[];
  links: GraphLink[];
}

/**
 * Convert a mirrored Node into the GraphNode shape used by evaluateQueryAST.
 */
function nodeToGraphNode(node: Node): GraphNode {
  return {
    uuid: node.uuid,
    name: node.name,
    type: node.is_page ? 'page' : 'block',
    tags: node.tags_uuid,
    class_uuids: node.classes_uuid,
    properties: node.properties_uuid,
    is_daily: node.is_daily,
    is_class: node.is_class,
    is_monthly: node.is_monthly,
    is_yearly: node.is_yearly,
    icon: node.icon ?? undefined,
  };
}

/**
 * Recursively walk inline AST nodes and collect referenced node UUIDs.
 */
function collectInlineReferences(nodes: ASTInlineNode[] | undefined, targets: Set<string>): void {
  if (!nodes) return;
  for (const n of nodes) {
    if (n.type === 'node_link') {
      const parsed = parseLinkId(n.link_id);
      if (parsed.nodeUuid) {
        targets.add(parsed.nodeUuid);
      }
    } else if ('children' in n && Array.isArray(n.children)) {
      collectInlineReferences(n.children, targets);
    }
  }
}

/**
 * Extract outgoing reference targets from a node's name AST and any
 * pre-resolved referenced_nodes map.
 */
function extractReferenceTargets(node: Node): string[] {
  const targets = new Set<string>();

  try {
    const doc = parseAST(node.name);
    for (const block of doc) {
      collectInlineReferences((block as ASTBlockNode).children, targets);
    }
  } catch {
    // Treat unparseable names as plain text with no links.
  }

  if (node.referenced_nodes) {
    for (const uuid of Object.keys(node.referenced_nodes)) {
      targets.add(uuid);
    }
  }

  return [...targets];
}

/**
 * Build a graph from the local node mirror.
 *
 * Parent links follow `parent_uuid` (source = parent, target = child).
 * Reference links are derived from parsed `[[uuid]]` / `((uuid))` node links
 * and from the `referenced_nodes` map.
 * Class and extends links support class-condition evaluation.
 */
export function buildLocalReferenceGraph(nodes: Node[]): LocalReferenceGraph {
  const graphNodes = nodes.map(nodeToGraphNode);
  const nodeByUuid = new Map(graphNodes.map((n) => [n.uuid, n]));
  const links: GraphLink[] = [];

  for (const node of nodes) {
    // Parent relationship: source = parent, target = child
    if (node.parent_uuid) {
      links.push({ source: node.parent_uuid, target: node.uuid, type: 'parent' });
    }

    // Class membership: source = node, target = class
    for (const classUuid of node.classes_uuid ?? []) {
      links.push({ source: node.uuid, target: classUuid, type: 'class' });
    }

    // Class extension: source = node/class, target = parent class
    for (const parentClassUuid of node.extends_uuid ?? []) {
      links.push({ source: node.uuid, target: parentClassUuid, type: 'extends' });
    }

    // Text/reference links
    for (const targetUuid of extractReferenceTargets(node)) {
      if (targetUuid !== node.uuid && nodeByUuid.has(targetUuid)) {
        links.push({ source: node.uuid, target: targetUuid, type: 'reference' });
      }
    }
  }

  return { nodes: graphNodes, links };
}
