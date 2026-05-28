/**
 * Task Query Utilities
 *
 * QueryAST builders for common task-based views.
 * All queries exclude tasks with status 'Done' or 'Cancelled'.
 */
import {
  createClassCondition,
  createPropertyCondition,
} from '@/types/queryAST';
import type { QueryAST, PropertyCondition } from '@/types/queryAST';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { dateToDayUuid, getTodayDayUuid } from '@/utils/dateUuid';

/**
 * Create conditions to exclude completed tasks (Done / Cancelled).
 */
function notCompletedConditions(): PropertyCondition[] {
  return [
    createPropertyCondition(
      'task_status',
      'not_equals',
      'Done',
      'select',
      SYSTEM_PROPERTY_UUIDS.task_status,
    ),
    createPropertyCondition(
      'task_status',
      'not_equals',
      'Cancelled',
      'select',
      SYSTEM_PROPERTY_UUIDS.task_status,
    ),
  ];
}

/**
 * Build a QueryAST that finds all non-completed task nodes.
 */
export function buildTasksQueryAST(): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        ...notCompletedConditions(),
      ],
    },
  };
}

/**
 * Build a QueryAST that finds tasks scheduled or deadlined for exactly today.
 */
export function buildTodayQueryAST(): QueryAST {
  const todayUuid = getTodayDayUuid();
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        ...notCompletedConditions(),
        {
          type: 'group',
          logic: 'OR',
          children: [
            createPropertyCondition(
              'task_scheduled',
              'equals',
              todayUuid,
              'date',
              SYSTEM_PROPERTY_UUIDS.task_scheduled,
            ),
            createPropertyCondition(
              'task_deadline',
              'equals',
              todayUuid,
              'date',
              SYSTEM_PROPERTY_UUIDS.task_deadline,
            ),
          ],
        },
      ],
    },
  };
}

/**
 * Build a QueryAST that finds tasks scheduled or deadlined
 * within the next N days (inclusive of today).
 */
export function buildUpcomingQueryAST(days = 7): QueryAST {
  const todayUuid = getTodayDayUuid();
  const future = new Date();
  future.setDate(future.getDate() + days + 1);
  const futureUuid = dateToDayUuid(future);

  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        ...notCompletedConditions(),
        {
          type: 'group',
          logic: 'OR',
          children: [
            {
              type: 'group',
              logic: 'AND',
              children: [
                createPropertyCondition(
                  'task_scheduled',
                  'is_not_empty',
                  undefined,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_scheduled,
                ),
                createPropertyCondition(
                  'task_scheduled',
                  'greater_than',
                  todayUuid,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_scheduled,
                ),
                createPropertyCondition(
                  'task_scheduled',
                  'less_than',
                  futureUuid,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_scheduled,
                ),
              ],
            },
            {
              type: 'group',
              logic: 'AND',
              children: [
                createPropertyCondition(
                  'task_deadline',
                  'is_not_empty',
                  undefined,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_deadline,
                ),
                createPropertyCondition(
                  'task_deadline',
                  'greater_than',
                  todayUuid,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_deadline,
                ),
                createPropertyCondition(
                  'task_deadline',
                  'less_than',
                  futureUuid,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_deadline,
                ),
              ],
            },
          ],
        },
      ],
    },
  };
}

/**
 * Build a QueryAST that finds tasks scheduled or deadlined
 * for today or earlier (overdue + today).
 */
export function buildTodayOverdueQueryAST(): QueryAST {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowUuid = dateToDayUuid(tomorrow);

  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        ...notCompletedConditions(),
        {
          type: 'group',
          logic: 'OR',
          children: [
            {
              type: 'group',
              logic: 'AND',
              children: [
                createPropertyCondition(
                  'task_scheduled',
                  'is_not_empty',
                  undefined,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_scheduled,
                ),
                createPropertyCondition(
                  'task_scheduled',
                  'less_than',
                  tomorrowUuid,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_scheduled,
                ),
              ],
            },
            {
              type: 'group',
              logic: 'AND',
              children: [
                createPropertyCondition(
                  'task_deadline',
                  'is_not_empty',
                  undefined,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_deadline,
                ),
                createPropertyCondition(
                  'task_deadline',
                  'less_than',
                  tomorrowUuid,
                  'date',
                  SYSTEM_PROPERTY_UUIDS.task_deadline,
                ),
              ],
            },
          ],
        },
      ],
    },
  };
}

/**
 * Build a QueryAST that finds tasks scheduled after today (future).
 */
export function buildFutureQueryAST(): QueryAST {
  const todayUuid = getTodayDayUuid();
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        ...notCompletedConditions(),
        createPropertyCondition(
          'task_scheduled',
          'greater_than',
          todayUuid,
          'date',
          SYSTEM_PROPERTY_UUIDS.task_scheduled,
        ),
      ],
    },
  };
}

/**
 * Build a QueryAST that finds tasks scheduled before today (overdue only).
 */
export function buildOverdueQueryAST(): QueryAST {
  const todayUuid = getTodayDayUuid();
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        ...notCompletedConditions(),
        createPropertyCondition(
          'task_scheduled',
          'less_than',
          todayUuid,
          'date',
          SYSTEM_PROPERTY_UUIDS.task_scheduled,
        ),
      ],
    },
  };
}

/**
 * Build a QueryAST that finds tasks scheduled for a specific day.
 */
export function buildScheduledForDayQueryAST(dayUuid: string): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        ...notCompletedConditions(),
        createPropertyCondition(
          'task_scheduled',
          'equals',
          dayUuid,
          'date',
          SYSTEM_PROPERTY_UUIDS.task_scheduled,
        ),
      ],
    },
  };
}
