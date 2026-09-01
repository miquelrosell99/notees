/**
 * Equivalence tests for custom property conditions after switching from
 * correlated EXISTS subqueries to decorrelated IN subqueries (see
 * generatePropertyCondition in compileToSqlite.ts).
 *
 * Every query runs twice: once as compiled (IN form) and once converted back
 * to the legacy EXISTS form via toLegacyPropertySql, asserting identical ids
 * plus the expected ids. Fixtures cover nodes without the property,
 * multi-value rows (idx > 0), and JSON null values.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { compileToSqlite } from '../compileToSqlite';
import { createTestDatabase } from '../../__tests__/helpers';
import { queryAll } from '../../db/sqlite';
import type { GroupNode, PropertyCondition, QueryAST, ScopeNode } from '@/types/queryAST';
import { toLegacyPropertySql } from './legacyPropertySql';

const PROP_SEL = '00000000-0000-0000-0009-000000000001';
const PROP_NUM = '00000000-0000-0000-0009-000000000002';

describe('property condition equivalence (IN vs legacy EXISTS)', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  async function seed() {
    const db = await createTestDatabase();
    const workspaceId = 'ws-prop';

    const insertNode = (id: string): void => {
      db.run(
        `INSERT INTO node (id, workspace_id, kind, class_ids, parent_id, content, text_content, active, created_at, updated_at)
         VALUES (?, ?, 'block', '[]', NULL, '[]', NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        [id, workspaceId]
      );
    };
    const insertProp = (id: string, nodeId: string, schemaId: string, value: string, idx = 0): void => {
      db.run(
        'INSERT INTO property_value (id, node_id, property_schema_id, value, idx) VALUES (?, ?, ?, ?, ?)',
        [id, nodeId, schemaId, value, idx]
      );
    };

    // n-none: no property rows at all.
    insertNode('n-none');
    // n-one: single selection value "A".
    insertNode('n-one');
    insertProp('pv-1', 'n-one', PROP_SEL, '"A"');
    // n-multi: two values, "A" (idx 0) and "B" (idx 1).
    insertNode('n-multi');
    insertProp('pv-2', 'n-multi', PROP_SEL, '"A"', 0);
    insertProp('pv-3', 'n-multi', PROP_SEL, '"B"', 1);
    // n-c: single value "C".
    insertNode('n-c');
    insertProp('pv-4', 'n-c', PROP_SEL, '"C"');
    // n-null: JSON null value.
    insertNode('n-null');
    insertProp('pv-5', 'n-null', PROP_SEL, 'null');
    // Numeric property holders (no selection property).
    insertNode('n-num10');
    insertProp('pv-6', 'n-num10', PROP_NUM, '10');
    insertNode('n-num5');
    insertProp('pv-7', 'n-num5', PROP_NUM, '5');

    return { db, workspaceId };
  }

  function propQuery(
    propUuid: string,
    operator: PropertyCondition['operator'],
    value: unknown,
    propertyType: PropertyCondition['property_type'] = 'selection'
  ): QueryAST {
    const condition: PropertyCondition = {
      type: 'condition',
      condition_type: 'property',
      property_name: 'custom_prop',
      property_type: propertyType,
      operator,
      value,
      property_uuid: propUuid,
    };
    const scope: ScopeNode = { type: 'scope', scope_type: 'entire_workspace' };
    const group: GroupNode = { type: 'group', logic: 'AND', children: [condition] };
    return { type: 'query', version: '1.0', scope, root_group: group };
  }

  async function expectEquivalent(ast: QueryAST, expectedIds: string[]): Promise<void> {
    const { db, workspaceId } = await seed();
    const compiled = compileToSqlite(ast, workspaceId);
    expect(compiled.sql).toContain('IN (SELECT node_id FROM property_value');
    const legacySql = toLegacyPropertySql(compiled.sql);
    expect(legacySql).toContain('EXISTS (SELECT 1 FROM property_value');

    const current = queryAll<{ id: string }>(db, compiled.sql, compiled.params as never).map((r) => r.id);
    const legacy = queryAll<{ id: string }>(db, legacySql, compiled.params as never).map((r) => r.id);
    expect(current, 'IN-form query must match the legacy EXISTS query').toEqual(legacy);
    expect(current).toEqual(expectedIds);
  }

  it('equals matches nodes having a row with the value', async () => {
    await expectEquivalent(propQuery(PROP_SEL, 'equals', 'A'), ['n-multi', 'n-one']);
    await expectEquivalent(propQuery(PROP_SEL, 'equals', 'B'), ['n-multi']);
    await expectEquivalent(propQuery(PROP_SEL, 'equals', 'Z'), []);
  });

  it('not_equals means "has a row with a different value"', async () => {
    // n-multi has "B" != "A"; n-c has "C". n-null (NULL != 'A' is NULL) and
    // nodes without the property do not match.
    await expectEquivalent(propQuery(PROP_SEL, 'not_equals', 'A'), ['n-c', 'n-multi']);
  });

  it('in / not_in over a value list', async () => {
    await expectEquivalent(propQuery(PROP_SEL, 'in', ['A', 'B']), ['n-multi', 'n-one']);
    // not_in is "no row with value in list" (NOT EXISTS semantics): nodes
    // without the property and the NULL-valued row also match.
    await expectEquivalent(propQuery(PROP_SEL, 'not_in', ['A', 'B']), [
      'n-c',
      'n-none',
      'n-null',
      'n-num10',
      'n-num5',
    ]);
  });

  it('is_empty / is_not_empty track row existence', async () => {
    await expectEquivalent(propQuery(PROP_SEL, 'is_empty', undefined), ['n-none', 'n-num10', 'n-num5']);
    await expectEquivalent(propQuery(PROP_SEL, 'is_not_empty', undefined), [
      'n-c',
      'n-multi',
      'n-null',
      'n-one',
    ]);
  });

  it('contains uses LIKE over the extracted value', async () => {
    await expectEquivalent(propQuery(PROP_SEL, 'contains', 'A'), ['n-multi', 'n-one']);
  });

  it('numeric greater_than / less_than use CAST AS REAL', async () => {
    await expectEquivalent(propQuery(PROP_NUM, 'greater_than', 6, 'number'), ['n-num10']);
    await expectEquivalent(propQuery(PROP_NUM, 'less_than', 6, 'number'), ['n-num5']);
  });

  it('handles multiple property conditions in one group', async () => {
    const ast = propQuery(PROP_SEL, 'not_equals', 'A');
    ast.root_group.children.push({
      type: 'condition',
      condition_type: 'property',
      property_name: 'custom_prop',
      property_type: 'selection',
      operator: 'in',
      value: ['B', 'C'],
      property_uuid: PROP_SEL,
    } as PropertyCondition);
    // has a row != 'A' AND has a row in (B, C): n-multi (B) and n-c (C).
    await expectEquivalent(ast, ['n-c', 'n-multi']);
  });
});
