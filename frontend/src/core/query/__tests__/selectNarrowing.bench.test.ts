/**
 * Performance regression benchmark for the narrow-SELECT change in
 * compileToSqlite: `SELECT n.id, n.active` instead of `SELECT DISTINCT n.*`.
 *
 * With wide content columns, SELECT * + DISTINCT forces SQLite to materialize
 * and dedup every scanned row's full content JSON. This test seeds ~10k nodes
 * with realistic multi-KB CRDT-wrapper content, runs a task-query AST and a
 * content-condition AST, and compares the wide legacy form against the narrow
 * compiled form.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createTestDatabase } from '../../__tests__/helpers';
import { compileToSqlite } from '../compileToSqlite';
import { queryAll } from '../../db/sqlite';
import { uuidv7 } from '../../uuid';
import type { ContentCondition, GroupNode, QueryAST } from '@/types/queryAST';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { buildOverdueQueryAST } from '@/utils/taskQueries';
import { extractTextContent } from '../../derived/textContent';

const NODE_COUNT = 10_000;
const TASK_COUNT = 400;

// Generous ceiling: ~3x the observed post-fix time (see task report for
// measurements); the wide legacy form is several times slower with this
// content-heavy dataset.
const MAX_QUERY_MS = 150;

const WORDS =
  'the quick brown fox jumps over a lazy dog while notes about projects meetings and ideas accumulate in the workspace'.split(
    ' '
  );

function sentence(seed: number, length: number): string {
  const words: string[] = [];
  for (let i = 0; i < length; i++) {
    words.push(WORDS[(seed + i * 7) % WORDS.length]);
  }
  return words.join(' ');
}

/** Multi-KB realistic editor-persisted content (CRDT wrapper form). */
function crdtWrapperContent(seed: number): string {
  const paragraphs: unknown[] = [];
  for (let p = 0; p < 6; p++) {
    paragraphs.push({
      type: 'paragraph',
      children: [
        { type: 'text', text: sentence(seed + p, 14) },
        { type: 'text', text: sentence(seed + p + 3, 6), marks: [{ type: 'strong' }] },
      ],
    });
  }
  return JSON.stringify([{ type: 'text', text: JSON.stringify(paragraphs) }]);
}

/** Restore the legacy wide SELECT for before/after comparison. */
function toWideSql(sql: string): string {
  return sql.replace('SELECT n.id, n.active\nFROM node n', 'SELECT DISTINCT n.*\nFROM node n');
}

function contentQuery(value: string): QueryAST {
  const condition: ContentCondition = {
    type: 'condition',
    condition_type: 'content',
    operator: 'contains',
    value,
  };
  const group: GroupNode = { type: 'group', logic: 'AND', children: [condition] };
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: group,
  };
}

/** Unfiltered whole-workspace query: the shape where the wide row hurts most. */
function matchAllQuery(): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: { type: 'group', logic: 'AND', children: [] },
  };
}

describe('narrow SELECT benchmark (id, active vs DISTINCT n.*)', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it(`runs task and content ASTs over ${NODE_COUNT} wide-content nodes quickly`, async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const needle = 'zxq-needle-phrase';

    db.run('INSERT INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)', [
      SYSTEM_CLASS_UUIDS.task,
      SYSTEM_CLASS_UUIDS.task,
    ]);

    const insertNode = (id: string, classIds: string[], content: string): void => {
      db.run(
        `INSERT INTO node (id, workspace_id, kind, class_ids, parent_id, content, text_content, active, created_at, updated_at)
         VALUES (?, ?, 'block', ?, NULL, ?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        [id, workspaceId, JSON.stringify(classIds), content, extractTextContent(content)]
      );
    };
    const insertProp = (nodeId: string, schemaId: string, value: unknown): void => {
      db.run(
        'INSERT INTO property_value (id, node_id, property_schema_id, value, idx) VALUES (?, ?, ?, ?, 0)',
        [uuidv7(), nodeId, schemaId, JSON.stringify(value)]
      );
    };

    const needleIds: string[] = [];
    db.exec('BEGIN TRANSACTION');
    try {
      for (let i = 0; i < NODE_COUNT; i++) {
        const id = uuidv7();
        // A handful of nodes contain the content needle.
        const hasNeedle = i % 2000 === 0;
        const content = hasNeedle
          ? crdtWrapperContent(i).replace(sentence(i, 14), `${sentence(i, 14)} ${needle}`)
          : crdtWrapperContent(i);
        insertNode(id, [], content);
        if (hasNeedle) needleIds.push(id);
      }
      for (let i = 0; i < TASK_COUNT; i++) {
        const id = uuidv7();
        insertNode(id, [SYSTEM_CLASS_UUIDS.task], crdtWrapperContent(i + NODE_COUNT));
        insertProp(id, SYSTEM_PROPERTY_UUIDS.task_status, i % 4 === 0 ? 'Done' : 'Pending');
        insertProp(id, SYSTEM_PROPERTY_UUIDS.task_scheduled, '00000000-0000-0000-00dd-202601010000');
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    needleIds.sort();

    const timeBoth = (
      label: string,
      ast: QueryAST
    ): { ids: string[]; wideIds: string[]; ms: number; wideMs: number } => {
      const compiled = compileToSqlite(ast, workspaceId);
      expect(compiled.sql).toContain('SELECT n.id, n.active\nFROM node n');
      const wideSql = toWideSql(compiled.sql);
      expect(wideSql).toContain('SELECT DISTINCT n.*');

      const start = performance.now();
      const rows = queryAll<{ id: string }>(db, compiled.sql, compiled.params as never);
      const ms = performance.now() - start;

      const wideStart = performance.now();
      const wideRows = queryAll<{ id: string }>(db, wideSql, compiled.params as never);
      const wideMs = performance.now() - wideStart;

      console.log(
        `[bench] ${label}: narrow=${ms.toFixed(1)}ms wide_distinct=${wideMs.toFixed(1)}ms (rows=${rows.length})`
      );
      return { ids: rows.map((r) => r.id), wideIds: wideRows.map((r) => r.id), ms, wideMs };
    };

    const task = timeBoth('overdue_task_ast', buildOverdueQueryAST());
    const content = timeBoth('content_contains_ast', contentQuery(needle));
    const matchAll = timeBoth('match_all_ast', matchAllQuery());

    // Correctness: narrow form matches the wide form and expectations.
    expect(task.ids).toEqual(task.wideIds);
    expect(task.ids.length).toBeGreaterThan(0);
    expect(content.ids).toEqual(content.wideIds);
    expect(content.ids).toEqual(needleIds);
    expect(matchAll.ids).toEqual(matchAll.wideIds);
    expect(matchAll.ids).toHaveLength(NODE_COUNT + TASK_COUNT);

    expect(task.ms).toBeLessThan(MAX_QUERY_MS);
    expect(content.ms).toBeLessThan(MAX_QUERY_MS);
    expect(matchAll.ms).toBeLessThan(MAX_QUERY_MS);
  }, 60_000);
});
