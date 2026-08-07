/**
 * useCoreDisplayName — Live display name from the local-first core store.
 *
 * Replaces the legacy runtime overlay hook for observers (inline links, pills,
 * breadcrumbs, recents/favorites) that must reflect a referenced block's content
 * the moment it is edited elsewhere.
 */
import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useNode } from '@/core/hooks';
import { useBatchNodesByUuid } from '@/features/content/hooks/useBatchNodesByUuid';
import { parseAST, parseLinkId, unwrapCrdtContentAst } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode, type NodeLinkResolver } from '@/lib/stringifyAST';
import type { ASTInlineNode } from '@/types/ast';
import type { Node } from '@/types';

interface LinkTarget {
  linkId: string;
  targetUuid: string;
  label?: string | null;
}

/**
 * Walk a document and collect every node_link target UUID.
 * Recurses into mark nodes (strong, em, external_link, etc.) so links inside
 * formatted text are not missed.
 */
function extractNodeLinkTargets(content: string): LinkTarget[] {
  const ast = unwrapCrdtContentAst(parseAST(content));
  const result: LinkTarget[] = [];

  function visitInlines(nodes: ASTInlineNode[]): void {
    for (const inline of nodes) {
      if (inline.type === 'node_link') {
        const { nodeUuid } = parseLinkId(inline.link_id);
        if (nodeUuid) {
          result.push({ linkId: inline.link_id, targetUuid: nodeUuid, label: inline.label });
        }
      } else if ('children' in inline && Array.isArray((inline as { children?: ASTInlineNode[] }).children)) {
        visitInlines((inline as { children: ASTInlineNode[] }).children);
      }
    }
  }

  for (const block of ast) {
    if ('children' in block && Array.isArray(block.children)) {
      visitInlines(block.children as ASTInlineNode[]);
    }
  }

  return result;
}

function buildContentResolver(linkMap: Map<string, Node>): NodeLinkResolver {
  return (linkId: string) => {
    const targetNode = linkMap.get(linkId);
    if (!targetNode) return null;
    return {
      targetAST: unwrapCrdtContentAst(parseAST(targetNode.content)),
      label: null,
      targetId: String(targetNode.uuid),
    };
  };
}

export function useCoreDisplayName(nodeUuid: string | null | undefined, fallback = ''): string {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { node } = useNode(workspaceId ?? '', nodeUuid ?? undefined);

  const content = node?.content;
  const linkTargets = useMemo(() => (content ? extractNodeLinkTargets(content) : []), [content]);
  const targetUuids = useMemo(() => linkTargets.map((t) => t.targetUuid), [linkTargets]);
  const { data: batchNodes } = useBatchNodesByUuid(targetUuids);

  return useMemo(() => {
    if (!content) return fallback;

    const ast = unwrapCrdtContentAst(parseAST(content));
    const linkMap = new Map<string, Node>();
    for (const { linkId, targetUuid } of linkTargets) {
      const targetNode = batchNodes?.nodes[targetUuid];
      if (targetNode) {
        linkMap.set(linkId, targetNode);
      }
    }

    const text = stringifyAST(ast, {
      mode: StringifyMode.TEXT_ONLY,
      resolveNodeLink: buildContentResolver(linkMap),
    });
    return text.trim() || fallback;
  }, [content, linkTargets, batchNodes, fallback]);
}
