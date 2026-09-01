/**
 * Performance regression benchmark for the unlinked_references system view.
 *
 * Every page renders an unlinked_references view whose AST contains an OR
 * group of two `content contains` conditions scoped to the entire workspace.
 * This test seeds ~10k nodes with realistic paragraph content, builds the AST
 * exactly like the app does, compiles it with compileToSqlite and times the
 * execution. See `frontend/src/core/derived/textContent.ts` for the fix.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createTestDatabase } from '../../__tests__/helpers';
import { compileToSqlite } from '../compileToSqlite';
import { substituteRuntimeParams } from '../substituteRuntimeParams';
import { queryAll } from '../../db/sqlite';
import { uuidv7 } from '../../uuid';
import { createEmptyQueryAST } from '@/types/queryAST';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { extractTextContent } from '../../derived/textContent';

const NODE_COUNT = 10_000;

// Generous ceiling: ~4x the observed post-fix time (~46ms isolated, ~121ms
// under full-suite load, in the dev container). The legacy per-row json_tree
// subquery took ~124-220ms for this dataset and degrades further as document
// size grows.
const MAX_QUERY_MS = 200;

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

function paragraphContent(text: string): string {
  return JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text }] }]);
}

/**
 * Realistic editor-persisted content: the inline editor serializes the real
 * AST to JSON and stores that string inside the node's text CRDT, so the
 * derived content column is `[{type:'text',text:'[<real AST>]'}]` with marks
 * and nested children inside.
 */
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

describe('unlinked_references query benchmark', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it(`executes the unlinked_references AST over ${NODE_COUNT} nodes quickly`, async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();

    // text_content exists only after the fix; populate it when present so the
    // same seeding logic produces a correct database before and after.
    const hasTextContent =
      db.exec("SELECT 1 FROM pragma_table_info('node') WHERE name = 'text_content'").length > 0;

    const currentPageId = uuidv7();
    const currentPageName = 'Benchmark Target Page';

    const insertSql = hasTextContent
      ? `INSERT INTO node (id, workspace_id, kind, class_ids, parent_id, content, text_content, active, created_at, updated_at)
         VALUES (?, ?, ?, '[]', NULL, ?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      : `INSERT INTO node (id, workspace_id, kind, class_ids, parent_id, content, active, created_at, updated_at)
         VALUES (?, ?, ?, '[]', NULL, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;

    const insertNode = (id: string, kind: 'page' | 'block', content: string): void => {
      if (hasTextContent) {
        db.run(insertSql, [id, workspaceId, kind, content, extractTextContent(content)]);
      } else {
        db.run(insertSql, [id, workspaceId, kind, content]);
      }
    };

    db.exec('BEGIN TRANSACTION');
    try {
      insertNode(currentPageId, 'page', paragraphContent(currentPageName));
      // Blocks that genuinely match: one mentions the page name, one the uuid.
      insertNode(uuidv7(), 'block', paragraphContent(`mentioning ${currentPageName} inline`));
      insertNode(uuidv7(), 'block', paragraphContent(`a raw [[${currentPageId}]] reference`));
      for (let i = 0; i < NODE_COUNT; i++) {
        insertNode(uuidv7(), i % 10 === 0 ? 'page' : 'block', crdtWrapperContent(i));
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // Build the AST exactly like useNodeViews does for the default system view.
    const fixed = autoFixSystemQuery(createEmptyQueryAST(), 'unlinked_references', {
      nodeUuid: currentPageId,
    });
    const ast = substituteRuntimeParams(fixed, {
      current_node_uuid: currentPageId,
      current_node_id: currentPageId,
      current_node_name: currentPageName,
    });

    const compiled = compileToSqlite(ast, workspaceId);

    const start = performance.now();
    const rows = queryAll<{ id: string }>(db, compiled.sql, compiled.params as never);
    const durationMs = performance.now() - start;

    // Also time the legacy per-row json_tree subquery for comparison, so the
    // benchmark output always shows the before/after relationship.
    const legacySql = compiled.sql
      .split('n.text_content')
      .join("(SELECT group_concat(value, '') FROM json_tree(n.content) WHERE key = 'text')");
    const legacyStart = performance.now();
    const legacyRows = queryAll<{ id: string }>(db, legacySql, compiled.params as never);
    const legacyDurationMs = performance.now() - legacyStart;

    console.log(
      `[bench] unlinked_references over ${NODE_COUNT + 3} nodes: ` +
        `text_content=${durationMs.toFixed(1)}ms legacy_json_tree=${legacyDurationMs.toFixed(1)}ms ` +
        `(rows=${rows.length})`
    );

    // Correctness: only the two matching blocks, not the page itself.
    expect(rows).toHaveLength(2);
    expect(legacyRows.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(durationMs).toBeLessThan(MAX_QUERY_MS);
  }, 60_000);
});
