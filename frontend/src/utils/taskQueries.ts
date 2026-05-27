/**
 * Task Query Utilities
 *
 * QueryAST builders for common task-based views.
 */
import {
  createEmptyQueryAST,
  createClassCondition,
  createPropertyCondition,
} from '@/types/queryAST';
import type { QueryAST } from '@/types/queryAST';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { generateDateUuid } from '@/utils/dateParser';

/**
 * Build a QueryAST that finds all nodes with class = task.
 */
export function buildTasksQueryAST(): QueryAST {
  const ast = createEmptyQueryAST();
  ast.scope.scope_type = 'entire_workspace';
  ast.root_group.children.push(createClassCondition(SYSTEM_CLASS_UUIDS.task));
  return ast;
}

function dateToParsedDate(date: Date) {
  return {
    type: 'day' as const,
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    label: '',
  };
}

/**
 * Build a QueryAST that finds tasks where deadline OR scheduled
 * relation points to today's day-node UUID.
 */
export function buildTodayQueryAST(): QueryAST {
  const todayUuid = generateDateUuid(dateToParsedDate(new Date()));
  const ast = createEmptyQueryAST();
  ast.scope.scope_type = 'entire_workspace';
  ast.root_group.logic = 'AND';
  ast.root_group.children.push(createClassCondition(SYSTEM_CLASS_UUIDS.task));
  ast.root_group.children.push({
    type: 'group',
    logic: 'OR',
    children: [
      createPropertyCondition(
        'Scheduled',
        'equals',
        todayUuid,
        'node',
        SYSTEM_PROPERTY_UUIDS.task_scheduled,
      ),
      createPropertyCondition(
        'Deadline',
        'equals',
        todayUuid,
        'node',
        SYSTEM_PROPERTY_UUIDS.task_deadline,
      ),
    ],
  });
  return ast;
}

/**
 * Build a QueryAST that finds tasks where deadline OR scheduled
 * is in the next 7 days.
 */
export function buildUpcomingQueryAST(): QueryAST {
  const uuids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    uuids.push(generateDateUuid(dateToParsedDate(d)));
  }

  const ast = createEmptyQueryAST();
  ast.scope.scope_type = 'entire_workspace';
  ast.root_group.logic = 'AND';
  ast.root_group.children.push(createClassCondition(SYSTEM_CLASS_UUIDS.task));
  ast.root_group.children.push({
    type: 'group',
    logic: 'OR',
    children: [
      createPropertyCondition(
        'Scheduled',
        'in',
        uuids,
        'node',
        SYSTEM_PROPERTY_UUIDS.task_scheduled,
      ),
      createPropertyCondition(
        'Deadline',
        'in',
        uuids,
        'node',
        SYSTEM_PROPERTY_UUIDS.task_deadline,
      ),
    ],
  });
  return ast;
}
