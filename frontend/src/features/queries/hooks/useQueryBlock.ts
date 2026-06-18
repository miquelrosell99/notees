import { useCallback, useRef, useEffect, useMemo } from 'react';
import { useNode, useUpdateNode } from '@/features/content';
import type { Node } from '@/types/api';
import type { ASTQuery } from '@/types/ast';
import { parseAST } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { createEmptyQueryAST } from '@/types/queryAST';
import type { QueryAST } from '@/types/queryAST';

// ─── Helpers ───────────────────────────────────────────────────────

function parseQueryBlockData(node: Node | undefined): QueryAST {
  if (!node?.name) return createEmptyQueryAST();
  const ast = parseAST(node.name);
  const qb = ast.find(b => b.type === 'query') as ASTQuery | undefined;
  return qb ? qb.data : createEmptyQueryAST();
}

function parseQueryBlockTitle(node: Node | undefined): string {
  if (!node?.name) return '';
  const ast = parseAST(node.name);
  const para = ast.find(b => b.type === 'paragraph' || b.type === 'heading');
  if (para) {
    return stringifyAST([para], { mode: StringifyMode.TEXT_ONLY });
  }
  return '';
}

// ─── Hook ──────────────────────────────────────────────────────────

export function useQueryBlock(nodeId: number | null) {
  const { data: node } = useNode(nodeId);
  const updateNode = useUpdateNode();
  const mutateRef = useRef(updateNode.mutate);
  mutateRef.current = updateNode.mutate;

  const titleRef = useRef<string>('');

  // Update title ref when node changes
  useEffect(() => {
    if (node) {
      titleRef.current = parseQueryBlockTitle(node);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only re-sync when the node identity changes, not every field mutation.
  }, [node?.id]);

  const queryAST = useMemo(
    () => parseQueryBlockData(node),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node?.name]
  );

  const saveQueryAST = useCallback((newAST: QueryAST) => {
    if (!nodeId) return;
    const nameAST = [
      { type: 'paragraph' as const, children: [{ type: 'text' as const, text: titleRef.current }] },
      { type: 'query' as const, data: newAST },
    ];
    mutateRef.current({ id: nodeId, data: { name: JSON.stringify(nameAST) } });
  }, [nodeId]);

  return { queryAST, saveQueryAST, node };
}
