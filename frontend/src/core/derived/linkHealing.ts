/**
 * Lazy self-healing for inline node_link AST targets.
 *
 * The ``node_link`` derived table is the canonical source for a link instance's
 * target. The AST stores the target UUID only as a safekeeping cache. When a
 * user navigates through a link, compare the AST target with the canonical
 * ``node_link.target_id`` and rewrite the AST if they have drifted apart.
 */

import { type Database } from 'sql.js';
import { queryOne } from '../db/sqlite';
import { parseAST, parseLinkId, buildLinkId, unwrapCrdtContentAst } from '@/lib/astBuilder';
import type { ASTInlineNode, ASTDocument } from '@/types/ast';

interface HealResult {
  /** The canonical target UUID from the node_link row, or the AST target if no link row exists. */
  canonicalTargetUuid: string | null;
  /** Whether the AST was rewritten because the AST target differed from the canonical target. */
  healed: boolean;
  /** The healed AST if rewritten, otherwise undefined. */
  newAst?: ASTDocument;
}

function mutateLinkInInlines(
  nodes: ASTInlineNode[],
  oldLinkId: string,
  newLinkId: string
): ASTInlineNode[] {
  return nodes.map((node) => {
    if (
      (node.type === 'node_link' || node.type === 'broken_link') &&
      node.link_id === oldLinkId
    ) {
      return { ...node, link_id: newLinkId };
    }
    if ('children' in node && Array.isArray((node as { children?: ASTInlineNode[] }).children)) {
      return {
        ...node,
        children: mutateLinkInInlines(
          (node as { children: ASTInlineNode[] }).children,
          oldLinkId,
          newLinkId
        ),
      };
    }
    return node;
  });
}

function mutateLinkInDocument(
  ast: ASTDocument,
  oldLinkId: string,
  newLinkId: string
): ASTDocument {
  return ast.map((block) => {
    if ('children' in block && Array.isArray(block.children)) {
      return {
        ...block,
        children: mutateLinkInInlines(
          block.children as ASTInlineNode[],
          oldLinkId,
          newLinkId
        ),
      } as ASTDocument[number];
    }
    return block;
  });
}

/**
 * Detect and optionally heal drift between an AST link and its canonical
 * ``node_link`` row.
 *
 * When ``linkId`` contains a link UUID, the function queries ``node_link`` for
 * that row. If the AST target UUID differs from ``node_link.target_id``, the
 * function returns ``newContent`` with the corrected link identifier. Callers
 * can then persist the content (e.g. via ``WorkspaceStore.updateContentAst``).
 *
 * Returns ``canonicalTargetUuid`` so navigation can proceed to the correct
 * target even when the caller decides not to rewrite the AST immediately.
 */
export function healNodeLinkTarget(
  db: Database,
  sourceNodeId: string,
  linkId: string,
  options: { heal?: boolean } = {}
): HealResult {
  const { nodeUuid: astTargetUuid, linkUuid } = parseLinkId(linkId);
  if (!astTargetUuid) {
    return { canonicalTargetUuid: null, healed: false };
  }

  let canonicalTargetUuid = astTargetUuid;

  if (linkUuid) {
    const row = queryOne<{ target_id: string }>(
      db,
      'SELECT target_id FROM node_link WHERE id = ? AND source_id = ?',
      [linkUuid, sourceNodeId]
    );
    if (row) {
      canonicalTargetUuid = row.target_id;
    }
  }

  if (canonicalTargetUuid === astTargetUuid) {
    return { canonicalTargetUuid, healed: false };
  }

  if (!options.heal) {
    return { canonicalTargetUuid, healed: false };
  }

  const sourceRow = queryOne<{ content: string }>(
    db,
    'SELECT content FROM node WHERE id = ?',
    [sourceNodeId]
  );
  if (!sourceRow) {
    return { canonicalTargetUuid, healed: false };
  }

  const ast = unwrapCrdtContentAst(parseAST(sourceRow.content));
  const newLinkId = buildLinkId(canonicalTargetUuid, linkUuid ?? astTargetUuid);
  const healedAst = mutateLinkInDocument(ast, linkId, newLinkId);

  return { canonicalTargetUuid, healed: true, newAst: healedAst };
}

/**
 * Return the canonical target UUID for a link, looking up the ``node_link`` row
 * when a link UUID is available.
 */
export function resolveCanonicalLinkTarget(
  db: Database,
  sourceNodeId: string,
  linkId: string
): string | null {
  return healNodeLinkTarget(db, sourceNodeId, linkId).canonicalTargetUuid;
}
