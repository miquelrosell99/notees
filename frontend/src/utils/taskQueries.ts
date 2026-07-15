/**
 * Task Query Utilities
 *
 * QueryAST builders for common task-based views.
 * All queries exclude tasks with status 'Done' or 'Cancelled'.
 * The tasks-popup builders (`buildPopup*`) additionally exclude the
 * non-actionable open statuses in `TASK_POPUP_HIDDEN_STATUSES`
 * ('Backlog', 'Reviewing'), so popup sections show Pending/Doing only.
 */
import {
  createClassCondition,
  createPropertyCondition,
} from '@/types/queryAST';
import type { QueryAST, PropertyCondition } from '@/types/queryAST';
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
  TASK_POPUP_HIDDEN_STATUSES,
} from '@/constants/systemProperties';
import { dateToDayUuid, getTodayDayUuid } from '@/utils/dateUuid';

/**
 * Create conditions to exclude completed tasks.
 */
function notCompletedConditions(): PropertyCondition[] {
  return Array.from(TASK_CLOSED_STATUSES).map((status) =>
    createPropertyCondition(
      'task_status',
      'not_equals',
      status,
      'selection',
      SYSTEM_PROPERTY_UUIDS.task_status,
    )
  );
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

// ==================== Tasks popup builders ====================

/**
 * Conditions for the tasks popup: open tasks only (not Done/Cancelled) and
 * only actionable statuses (not Backlog/Reviewing).
 */
function popupOpenConditions(): PropertyCondition[] {
  return [
    ...notCompletedConditions(),
    ...Array.from(TASK_POPUP_HIDDEN_STATUSES).map((status) =>
      createPropertyCondition(
        'task_status',
        'not_equals',
        status,
        'selection',
        SYSTEM_PROPERTY_UUIDS.task_status,
      )
    ),
  ];
}

/** Date OR-group: (prop is_not_empty AND prop < dayUuid) for scheduled or deadline. */
function beforeDayOrGroup(dayUuid: string) {
  return {
    type: 'group' as const,
    logic: 'OR' as const,
    children: [
      {
        type: 'group' as const,
        logic: 'AND' as const,
        children: [
          createPropertyCondition('task_scheduled', 'is_not_empty', undefined, 'date', SYSTEM_PROPERTY_UUIDS.task_scheduled),
          createPropertyCondition('task_scheduled', 'less_than', dayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_scheduled),
        ],
      },
      {
        type: 'group' as const,
        logic: 'AND' as const,
        children: [
          createPropertyCondition('task_deadline', 'is_not_empty', undefined, 'date', SYSTEM_PROPERTY_UUIDS.task_deadline),
          createPropertyCondition('task_deadline', 'less_than', dayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_deadline),
        ],
      },
    ],
  };
}

function popupTaskAST(dateClause: unknown): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        ...popupOpenConditions(),
        dateClause,
      ],
    },
  } as QueryAST;
}

/** Overdue for the popup: scheduled or deadlined before today, Pending/Doing only. */
export function buildPopupOverdueQueryAST(): QueryAST {
  return popupTaskAST(beforeDayOrGroup(getTodayDayUuid()));
}

/** Today for the popup: scheduled or deadlined exactly today, Pending/Doing only. */
export function buildPopupTodayQueryAST(): QueryAST {
  const todayUuid = getTodayDayUuid();
  return popupTaskAST({
    type: 'group',
    logic: 'OR',
    children: [
      createPropertyCondition('task_scheduled', 'equals', todayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_scheduled),
      createPropertyCondition('task_deadline', 'equals', todayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_deadline),
    ],
  });
}

/** Upcoming for the popup: scheduled or deadlined within the next `days` days. */
export function buildPopupUpcomingQueryAST(days = 7): QueryAST {
  const todayUuid = getTodayDayUuid();
  const future = new Date();
  future.setDate(future.getDate() + days + 1);
  const futureUuid = dateToDayUuid(future);
  return popupTaskAST({
    type: 'group',
    logic: 'OR',
    children: ['task_scheduled', 'task_deadline'].map((prop) => ({
      type: 'group' as const,
      logic: 'AND' as const,
      children: [
        createPropertyCondition(prop, 'is_not_empty', undefined, 'date', SYSTEM_PROPERTY_UUIDS[prop as 'task_scheduled' | 'task_deadline']),
        createPropertyCondition(prop, 'greater_than', todayUuid, 'date', SYSTEM_PROPERTY_UUIDS[prop as 'task_scheduled' | 'task_deadline']),
        createPropertyCondition(prop, 'less_than', futureUuid, 'date', SYSTEM_PROPERTY_UUIDS[prop as 'task_scheduled' | 'task_deadline']),
      ],
    })),
  });
}

/** Completed today for the popup: Done tasks whose closed date is today. */
export function buildPopupCompletedTodayQueryAST(): QueryAST {
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
        createPropertyCondition('task_status', 'equals', 'Done', 'selection', SYSTEM_PROPERTY_UUIDS.task_status),
        createPropertyCondition('task_closed_date', 'equals', todayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_closed_date),
      ],
    },
  };
}
