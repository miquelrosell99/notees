/**
 * React hook for using the canonical AST stringifier with live data.
 *
 * Provides a `NodeLinkResolver` backed by React Query cache,
 * so that `stringifyAST` can resolve node links without any
 * database access of its own.
 */
import { useCallback, useMemo } from 'react';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import type { NodeLinkResolver, NodeLinkResolution } from '@/lib/stringifyAST';
import { parseAST } from '@/lib/astBuilder';
import type { ASTDocument } from '@/types/ast';
import type { Node } from '@/types';

/**
 * Data required to build a resolver from pre-fetched data.
 *
 * `linkMap` maps link_id (node_link UUID) → { targetNode, label }.
 * The caller is responsible for fetching this from useTextLinks or equivalent.
 */
export interface LinkMapEntry {
  /** The target node (with its name AST). */
  targetNode: Node;
  /** Fallback label (null = use target node's name; AST label takes precedence). */
  label: string | null;
}

/**
 * Build a NodeLinkResolver from a pre-fetched link map.
 *
 * This is a pure function — no React hooks. Use it when you have
 * the link data already and just need a resolver.
 */
export function buildResolver(linkMap: Map<string, LinkMapEntry>): NodeLinkResolver {
  return (linkId: string): NodeLinkResolution | null => {
    const entry = linkMap.get(linkId);
    if (!entry) return null;
    return {
      targetAST: parseAST(entry.targetNode.name),
      label: entry.label,
      targetId: String(entry.targetNode.uuid),
    };
  };
}

/**
 * Hook that returns a memoized `stringify` function for AST documents.
 *
 * Usage:
 * ```ts
 * const { stringify } = useStringifyAST(linkMap);
 * const text = stringify(node.name, StringifyMode.TEXT_ONLY);
 * ```
 *
 * @param linkMap - Map of link_id → { targetNode, label }. Can be empty.
 */
export function useStringifyAST(linkMap: Map<string, LinkMapEntry>) {
  const resolver = useMemo(() => buildResolver(linkMap), [linkMap]);

  const stringify = useCallback(
    (ast: ASTDocument, mode: StringifyMode, maxLength?: number): string => {
      return stringifyAST(ast, {
        mode,
        maxLength,
        resolveNodeLink: resolver,
      });
    },
    [resolver],
  );

  return { stringify, resolver };
}

/**
 * Convenience: stringify a single node's name to plain text.
 * Useful for search, display_name fallback, etc.
 *
 * Does NOT resolve node links (no resolver) — links render as "…".
 * Use `useStringifyAST` when you need link resolution.
 */
export function nodeNameToText(nameValue: unknown, maxLength?: number): string {
  const ast = parseAST(nameValue);
  return stringifyAST(ast, {
    mode: StringifyMode.TEXT_ONLY,
    maxLength,
  });
}

/**
 * Convenience: stringify a single node's name to NODE_MARKDOWN.
 *
 * Does NOT resolve node links (no resolver) — links render as [[…]].
 * Use `useStringifyAST` when you need link resolution.
 */
export function nodeNameToMarkdown(nameValue: unknown, maxLength?: number): string {
  const ast = parseAST(nameValue);
  return stringifyAST(ast, {
    mode: StringifyMode.NODE_MARKDOWN,
    maxLength,
  });
}
