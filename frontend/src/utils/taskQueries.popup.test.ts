import { describe, it, expect } from 'vitest';
import {
  buildPopupOverdueQueryAST,
  buildPopupTodayQueryAST,
  buildPopupUpcomingQueryAST,
  buildPopupUnscheduledQueryAST,
  buildPopupCompletedTodayQueryAST,
} from './taskQueries';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { getTodayDayUuid } from '@/utils/dateUuid';
import type { QueryAST, PropertyCondition } from '@/types/queryAST';

/** Recursively collect all property conditions in an AST. */
function collectConditions(ast: QueryAST): PropertyCondition[] {
  const out: PropertyCondition[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; condition_type?: string; children?: unknown[] };
    if (n.type === 'condition' && n.condition_type === 'property') {
      out.push(n as unknown as PropertyCondition);
    }
    n.children?.forEach(walk);
  };
  walk(ast.root_group);
  return out;
}

function statusConditions(ast: QueryAST): PropertyCondition[] {
  return collectConditions(ast).filter((c) => c.property_name === 'task_status');
}

describe('popup task query ASTs', () => {
  it.each([
    ['overdue', buildPopupOverdueQueryAST],
    ['today', buildPopupTodayQueryAST],
    ['upcoming', buildPopupUpcomingQueryAST],
    ['unscheduled', buildPopupUnscheduledQueryAST],
  ] as const)('%s shows only Pending/Doing tasks', (_name, build) => {
    const excluded = statusConditions(build())
      .filter((c) => c.operator === 'not_equals')
      .map((c) => c.value);
    expect(excluded).toEqual(expect.arrayContaining(['Done', 'Cancelled', 'Backlog', 'Reviewing']));
  });

  it('overdue is bounded before today on scheduled or deadline', () => {
    const conds = collectConditions(buildPopupOverdueQueryAST());
    const bounds = conds.filter((c) => c.operator === 'less_than').map((c) => [c.property_name, c.value]);
    expect(bounds).toContainEqual(['task_scheduled', getTodayDayUuid()]);
    expect(bounds).toContainEqual(['task_deadline', getTodayDayUuid()]);
  });

  it('upcoming is bounded after today and within 7 days by default', () => {
    const conds = collectConditions(buildPopupUpcomingQueryAST());
    const greater = conds.filter((c) => c.operator === 'greater_than').map((c) => c.value);
    expect(greater).toContain(getTodayDayUuid());
    expect(conds.some((c) => c.operator === 'less_than')).toBe(true);
  });

  it('unscheduled requires both scheduled and deadline to be empty', () => {
    const conds = collectConditions(buildPopupUnscheduledQueryAST());
    const empties = conds.filter((c) => c.operator === 'is_empty').map((c) => c.property_name);
    expect(empties).toContain('task_scheduled');
    expect(empties).toContain('task_deadline');
  });

  it.each([
    ['overdue', buildPopupOverdueQueryAST],
    ['today', buildPopupTodayQueryAST],
    ['upcoming', buildPopupUpcomingQueryAST],
    ['unscheduled', buildPopupUnscheduledQueryAST],
    ['completed', buildPopupCompletedTodayQueryAST],
  ] as const)('%s routes task_status conditions through the selection tables', (_name, build) => {
    // The backend QueryAST compiler only routes property_type 'selection' to
    // the selection-value tables; any other value silently mis-filters.
    const types = statusConditions(build()).map((c) => c.property_type);
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((t) => t === 'selection')).toBe(true);
  });

  it('completed-today selects Done tasks closed today', () => {
    const conds = collectConditions(buildPopupCompletedTodayQueryAST());
    expect(conds).toContainEqual(
      expect.objectContaining({ property_name: 'task_status', operator: 'equals', value: 'Done' }),
    );
    expect(conds).toContainEqual(
      expect.objectContaining({
        property_name: 'task_closed_date',
        operator: 'equals',
        value: getTodayDayUuid(),
        property_uuid: SYSTEM_PROPERTY_UUIDS.task_closed_date,
      }),
    );
    expect(statusConditions(buildPopupCompletedTodayQueryAST()).some((c) => c.operator === 'not_equals')).toBe(false);
  });
});
