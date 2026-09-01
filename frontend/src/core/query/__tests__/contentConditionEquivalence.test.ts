/**
 * Equivalence tests for content/name query conditions after the switch from a
 * per-row `json_tree(n.content)` subquery to the precomputed `n.text_content`
 * column (see `frontend/src/core/derived/textContent.ts`).
 *
 * Every assertion runs the compiled SQL twice: once as-is (column read) and
 * once with `n.text_content` textually replaced by the legacy subquery, and
 * requires identical result ids plus the expected ids.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { compileToSqlite } from '../compileToSqlite';
import { createTestDatabase } from '../../__tests__/helpers';
import { WorkspaceStore } from '../../store';
import { queryAll } from '../../db/sqlite';
import type {
  ContentCondition,
  GroupNode,
  PropertyCondition,
  QueryAST,
  ScopeNode,
} from '@/types/queryAST';

const LEGACY_TEXT_EXPR =
  "(SELECT group_concat(value, '') FROM json_tree(n.content) WHERE key = 'text')";

const WRAPPER_INNER = JSON.stringify([
  { type: 'paragraph', children: [{ type: 'text', text: 'Inner Real Text' }] },
]);

describe('content condition equivalence (text_content vs legacy json_tree)', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  async function seedStore() {
    const db = await createTestDatabase();
    const workspaceId = 'ws-equiv';
    const store = new WorkspaceStore(db, workspaceId, 'actor');

    // CRDT text updates store bare inline text nodes at document level.
    store.createNode({ nodeId: 'page-alpha', kind: 'page', parentId: null });
    store.updateText('page-alpha', (text) => text.insert(0, 'Hello World'));

    // Structured AST with nested children and marks.
    store.createNode({ nodeId: 'block-beta', kind: 'block', parentId: null });
    store.updateContentAst('block-beta', [
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Hello brave ' },
          { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
        ],
      },
    ]);

    // CRDT wrapper form: the text leaf is itself a serialized AST document and
    // must be matched verbatim.
    store.createNode({ nodeId: 'block-wrapper', kind: 'block', parentId: null });
    store.updateContentAst('block-wrapper', [{ type: 'text', text: WRAPPER_INNER }]);

    // No text leaves at all -> text_content IS NULL.
    store.createNode({ nodeId: 'page-empty', kind: 'page', parentId: null });

    // A single empty text leaf -> text_content = '' (not NULL).
    store.createNode({ nodeId: 'block-emptytext', kind: 'block', parentId: null });
    store.updateContentAst('block-emptytext', [{ type: 'text', text: '' }]);

    return { db, workspaceId, store };
  }

  function scope(): ScopeNode {
    return { type: 'scope', scope_type: 'entire_workspace' };
  }

  function contentQuery(
    operator: ContentCondition['operator'],
    value: string,
    caseSensitive?: boolean
  ): QueryAST {
    const condition: ContentCondition = {
      type: 'condition',
      condition_type: 'content',
      operator,
      value,
      ...(caseSensitive !== undefined ? { case_sensitive: caseSensitive } : {}),
    };
    const group: GroupNode = { type: 'group', logic: 'AND', children: [condition] };
    return { type: 'query', version: '1.0', scope: scope(), root_group: group };
  }

  function nameQuery(operator: PropertyCondition['operator'], value?: unknown): QueryAST {
    const condition: PropertyCondition = {
      type: 'condition',
      condition_type: 'property',
      property_name: 'name',
      property_type: 'text',
      operator,
      value,
    };
    const group: GroupNode = { type: 'group', logic: 'AND', children: [condition] };
    return { type: 'query', version: '1.0', scope: scope(), root_group: group };
  }

  function runBoth(
    db: Awaited<ReturnType<typeof createTestDatabase>>,
    ast: QueryAST,
    workspaceId: string
  ): { current: string[]; legacy: string[] } {
    const compiled = compileToSqlite(ast, workspaceId);
    expect(compiled.sql).toContain('n.text_content');
    const legacySql = compiled.sql.split('n.text_content').join(LEGACY_TEXT_EXPR);
    const current = queryAll<{ id: string }>(db, compiled.sql, compiled.params as never).map((r) => r.id);
    const legacy = queryAll<{ id: string }>(db, legacySql, compiled.params as never).map((r) => r.id);
    return { current, legacy };
  }

  async function expectEquivalent(ast: QueryAST, expectedIds: string[]): Promise<void> {
    const { db, workspaceId } = await seedStore();
    const { current, legacy } = runBoth(db, ast, workspaceId);
    expect(current, 'text_content query must match the legacy json_tree query').toEqual(legacy);
    expect(current).toEqual(expectedIds);
  }

  it('contains, case-insensitive (default)', async () => {
    await expectEquivalent(contentQuery('contains', 'hello'), ['block-beta', 'page-alpha']);
    await expectEquivalent(contentQuery('contains', 'WORLD'), ['block-beta', 'page-alpha']);
  });

  it('contains with case_sensitive still uses SQLite LIKE (case-insensitive for ASCII)', async () => {
    // Pre-existing compiler behavior: LIKE ignores case unless
    // PRAGMA case_sensitive_like is set; the legacy query behaved the same.
    await expectEquivalent(contentQuery('contains', 'Hello', true), ['block-beta', 'page-alpha']);
    await expectEquivalent(contentQuery('contains', 'hello', true), ['block-beta', 'page-alpha']);
  });

  it('starts_with, both case modes', async () => {
    await expectEquivalent(contentQuery('starts_with', 'hello'), ['block-beta', 'page-alpha']);
    await expectEquivalent(contentQuery('starts_with', 'hello', true), ['block-beta', 'page-alpha']);
    await expectEquivalent(contentQuery('starts_with', 'Hello', true), ['block-beta', 'page-alpha']);
  });

  it('ends_with, both case modes', async () => {
    await expectEquivalent(contentQuery('ends_with', 'world'), ['block-beta', 'page-alpha']);
    await expectEquivalent(contentQuery('ends_with', 'World', true), ['block-beta', 'page-alpha']);
  });

  it('equals, both case modes', async () => {
    await expectEquivalent(contentQuery('equals', 'hello world'), ['page-alpha']);
    await expectEquivalent(contentQuery('equals', 'hello world', true), []);
    await expectEquivalent(contentQuery('equals', 'Hello World', true), ['page-alpha']);
  });

  it('matches the CRDT wrapper inner JSON verbatim', async () => {
    await expectEquivalent(contentQuery('contains', 'Inner Real Text'), ['block-wrapper']);
    await expectEquivalent(contentQuery('contains', '{"type":"paragraph"', true), ['block-wrapper']);
    await expectEquivalent(contentQuery('equals', WRAPPER_INNER, true), ['block-wrapper']);
  });

  it('never matches nodes without text leaves for contains', async () => {
    await expectEquivalent(contentQuery('contains', 'Untitled'), []);
    await expectEquivalent(contentQuery('contains', 'e'), ['block-beta', 'block-wrapper', 'page-alpha']);
  });

  it('builtin name property is_empty / is_not_empty use IS NULL semantics', async () => {
    await expectEquivalent(nameQuery('is_empty'), ['page-empty']);
    await expectEquivalent(nameQuery('is_not_empty'), [
      'block-beta',
      'block-emptytext',
      'block-wrapper',
      'page-alpha',
    ]);
  });

  it('builtin name property contains/equals match content semantics', async () => {
    await expectEquivalent(nameQuery('contains', 'hello'), ['block-beta', 'page-alpha']);
    await expectEquivalent(nameQuery('equals', 'Hello World'), ['page-alpha']);
  });
});
