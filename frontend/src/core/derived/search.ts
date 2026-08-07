import { type Database } from 'sql.js';
import { queryOne } from '../db/sqlite';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { parseAST, parseLinkId, unwrapCrdtContentAst } from '@/lib/astBuilder';
import type { ASTDocument } from '@/types/ast';

/**
 * Extract searchable plain text from a node content AST.
 *
 * Uses the canonical stringifier so every AST node type (paragraphs, headings,
 * code, math, links, whiteboards, etc.) contributes text. When a resolver is
 * provided, node links are resolved recursively so a page is findable by the
 * names of pages that link to it; cycle detection prevents infinite recursion.
 */
export function extractPlaintext(
  content: unknown[],
  resolveNodeLink?: ReturnType<typeof makeDbNodeLinkResolver>,
): string {
  // Content is stored as a JSON array. Guard against non-array payloads.
  const ast = Array.isArray(content) ? (content as ASTDocument) : [];
  if (ast.length === 0) return '';

  const fromBlocks = stringifyAST(ast, {
    mode: StringifyMode.TEXT_ONLY,
    resolveNodeLink: resolveNodeLink ?? makeNoopResolver(),
  });
  if (fromBlocks.trim().length > 0) {
    return fromBlocks;
  }

  // CRDT text updates store bare inline text nodes at document level
  // (e.g. [{type:'text',text:'...'}]) rather than wrapped in paragraphs.
  // Fall back to collecting every text leaf in the raw content array.
  return collectTextLeaves(content).join(' ').trim();
}

function collectTextLeaves(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(collectTextLeaves);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string' && obj.text.length > 0) {
      return [obj.text];
    }
    return Object.values(obj).flatMap(collectTextLeaves);
  }
  return [];
}

/**
 * Resolver-free variant: indexes the visible label of a node link if present,
 * otherwise a stable placeholder. This avoids recursive DB reads during the
 * hot path of indexing, while still handling the full AST shape correctly.
 */
function makeNoopResolver() {
  return () => null;
}

/**
 * Build a resolver that looks up linked target nodes in the local DB.
 *
 * Useful when indexing should include the resolved name of referenced pages,
 * e.g. searching for "Project A" also finds blocks that only contain a link
 * labelled "Project A". Cycles are handled by stringifyAST internally.
 */
export function makeDbNodeLinkResolver(db: Database) {
  return (linkId: string) => {
    const { nodeUuid } = parseLinkId(linkId);
    const row = queryOne<{ content: string }>(db, 'SELECT content FROM node WHERE id = ?', [nodeUuid]);
    if (!row) return null;
    return {
      targetAST: unwrapCrdtContentAst(parseAST(row.content)),
      label: null,
      targetId: nodeUuid,
    };
  };
}

export function reindexNode(db: Database, nodeId: string): void {
  const row = queryOne<{ content: string }>(db, 'SELECT content FROM node WHERE id = ?', [nodeId]);
  if (!row) return;

  const content = JSON.parse(row.content) as unknown[];
  const ast = Array.isArray(content) ? (content as ASTDocument) : [];
  if (ast.length === 0) {
    db.run('DELETE FROM search_index WHERE node_id = ?', [nodeId]);
    return;
  }

  const plaintext = extractPlaintext(content, makeDbNodeLinkResolver(db));

  if (plaintext.length === 0) {
    db.run('DELETE FROM search_index WHERE node_id = ?', [nodeId]);
    return;
  }

  db.run(
    `INSERT OR REPLACE INTO search_index(docid, node_id, content)
     VALUES ((SELECT docid FROM search_index WHERE node_id = ?), ?, ?)`,
    [nodeId, nodeId, plaintext],
  );
}
