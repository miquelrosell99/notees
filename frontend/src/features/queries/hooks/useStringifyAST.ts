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
import { parseAST, unwrapCrdtContentAst } from '@/lib/astBuilder';
import type { ASTDocument } from '@/types/ast';
import type { Node } from '@/types';

/**
 * Data required to build a resolver from pre-fetched data.
 *
 * `linkMap` maps link_id (node_link UUID) → { targetNode, label }.
 * The caller is responsible for fetching this from useTextLinks or equivalent.
 */
export interface LinkMapEntry {
  /** The target node (with its content AST). */
  targetNode: Node;
  /** Fallback label (null = use target node's content; AST label takes precedence). */
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
      targetAST: unwrapCrdtContentAst(parseAST(entry.targetNode.content)),
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

function findFirstText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstText(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string' && obj.text.length > 0) {
      return obj.text;
    }
    for (const child of Object.values(obj)) {
      const found = findFirstText(child);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

function extractFirstLinkFallback(ast: ReturnType<typeof parseAST>): string | undefined {
  for (const block of ast) {
    const children = (block as { children?: unknown[] }).children;
    if (!Array.isArray(children)) continue;
    for (const inline of children) {
      const node = inline as { type?: string; link_id?: string; label?: string | null };
      if (node.type === 'node_link' && node.link_id) {
        if (node.label) return node.label;
        return 'Link';
      }
    }
  }
  return undefined;
}

function truncate(str: string, maxLength?: number): string {
  if (maxLength == null || str.length <= maxLength) return str;
  return str.slice(0, maxLength);
}

/**
 * Convenience: stringify a single node's name to plain text.
 * Useful for search, display_name fallback, etc.
 *
 * Handles:
 * - Formal AST documents (paragraph/text blocks).
 * - Legacy bare inline text nodes at document level (e.g. [{"type":"text","text":"..."}]).
 * - Plain text names such as compact numeric date content ("20260805").
 *
 * Does NOT resolve node links (no resolver) — links render as "…".
 * Use `useStringifyAST` when you need link resolution.
 */
export function nodeNameToText(nameValue: unknown, maxLength?: number): string {
  const ast = unwrapCrdtContentAst(parseAST(nameValue));
  let text = stringifyAST(ast, {
    mode: StringifyMode.TEXT_ONLY,
    maxLength,
  });

  if (!text.trim() || text.trim() === '…') {
    // If the only inline content is a node_link, stringifyAST returns "…"
    // because it has no resolver. Fall back to the link label or target UUID.
    const linkFallback = extractFirstLinkFallback(ast);
    if (linkFallback) {
      text = truncate(linkFallback, maxLength);
    }
  }

  if (!text.trim()) {
    // Some content is stored as bare inline text nodes at document level.
    const firstText = findFirstText(ast);
    if (firstText) {
      text = truncate(firstText, maxLength);
    } else if (typeof nameValue === 'string') {
      // Plain text names (e.g. compact numeric date content) are valid JSON
      // scalars, so parseAST returns an empty document for them. Fall back to
      // the raw string, but avoid treating JSON arrays/objects as display text.
      const trimmed = nameValue.trim();
      if (trimmed && !trimmed.startsWith('[') && !trimmed.startsWith('{')) {
        text = truncate(trimmed, maxLength);
      }
    }
  }

  return text;
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
