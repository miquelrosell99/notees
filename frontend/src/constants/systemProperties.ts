/**
 * System property UUIDs - these match the fixed UUIDs in the backend schema.
 * 
 * These UUIDs are used to identify system properties reliably,
 * avoiding name-based lookups which could conflict with user-created properties.
 */

export const SYSTEM_PROPERTY_UUIDS = {
  tags: '00000000-0000-0000-0000-000000000001',
  // 'classes' removed - now stored directly in node.class_ids column
  show_hierarchy: '00000000-0000-0000-0000-000000000003',
  used_in: '00000000-0000-0000-0000-000000000004',
  cover: '00000000-0000-0000-0000-000000000005',
  banner: '00000000-0000-0000-0000-000000000006',
  description: '00000000-0000-0000-0000-000000000009',
  extends: '00000000-0000-0000-0000-000000000008',
  _whiteboard_data: '00000000-0000-0000-0000-000000000010',  // Whiteboard layout JSON
  // Task class properties
  task_status: '00000000-0000-0000-0003-000000000001',
  task_deadline: '00000000-0000-0000-0003-000000000002',
  task_scheduled: '00000000-0000-0000-0003-000000000003',
  task_priority: '00000000-0000-0000-0003-000000000004',
  task_closed_date: '00000000-0000-0000-0003-000000000005',
  task_recurrence: '00000000-0000-0000-0003-000000000006',
} as const;

/** All task status names, ordered to match the backend TASK_STATUS_OPTIONS. */
export const TASK_STATUSES = [
  'Backlog',
  'Pending',
  'Doing',
  'Reviewing',
  'Done',
  'Cancelled',
] as const;

/** Terminal task statuses that should be treated as "completed". */
export const TASK_CLOSED_STATUSES = new Set<string>(['Done', 'Cancelled']);

/** Open statuses hidden from the tasks popup (still open, but not actionable there). */
export const TASK_POPUP_HIDDEN_STATUSES = new Set<string>(['Backlog', 'Reviewing']);

/**
 * Ordered list of the non-terminal task statuses.
 *
 * Cancelled is intentionally excluded: it is a terminal state that should be
 * set explicitly rather than reached through linear ordering.
 *
 * Note: the Ctrl/Cmd+Enter shortcut does NOT walk this list. It is a
 * Roam/Logseq-style three-state toggle (none -> Pending -> Done -> none)
 * implemented in `useTaskActions`. This constant is kept as the canonical
 * ordering of the open statuses for other UI consumers.
 */
export const TASK_STATUS_CYCLE = [
  'Backlog',
  'Pending',
  'Doing',
  'Reviewing',
  'Done',
] as const;

/**
 * System class UUIDs - these match the fixed UUIDs in the backend schema.
 * 
 * These UUIDs are used to identify system classes reliably.
 */
export const SYSTEM_CLASS_UUIDS = {
  class: '00000000-0000-0000-0001-000000000001',
  page: '00000000-0000-0000-0001-000000000002',
  year: '00000000-0000-0000-0001-000000000003',
  month: '00000000-0000-0000-0001-000000000004',
  day: '00000000-0000-0000-0001-000000000005',
  quote: '00000000-0000-0000-0001-000000000006',
  query: '00000000-0000-0000-0001-000000000007',
  code: '00000000-0000-0000-0001-000000000008',
  asset: '00000000-0000-0000-0001-000000000009',
  whiteboard: '00000000-0000-0000-0001-000000000010',
  card: '00000000-0000-0000-0001-000000000011',
  task: '00000000-0000-0000-0001-000000000012',
  template: '00000000-0000-0000-0001-000000000013',
  comment: '00000000-0000-0000-0001-000000000014',
  table: '00000000-0000-0000-0001-000000000015',
  warning: '00000000-0000-0000-0001-000000000016',
  note: '00000000-0000-0000-0001-000000000017',
  tip: '00000000-0000-0000-0001-000000000018',
  info: '00000000-0000-0000-0001-000000000019',
  danger: '00000000-0000-0000-0001-000000000020',
  success: '00000000-0000-0000-0001-000000000021',
  cloze: '00000000-0000-0000-0001-000000000022',
} as const;

/**
 * System page UUIDs - fixed UUIDs for system pages.
 */
export const SYSTEM_PAGE_UUIDS = {
  scratchpad: '00000000-0000-0000-0002-000000000001',
  inbox: '00000000-0000-0000-0002-000000000002',
} as const;

/**
 * Check if a property UUID is a system property
 */
export function isSystemPropertyUuid(uuid: string): boolean {
  return Object.values(SYSTEM_PROPERTY_UUIDS).includes(uuid as typeof SYSTEM_PROPERTY_UUIDS[keyof typeof SYSTEM_PROPERTY_UUIDS]);
}

/**
 * Check if a property is the 'Cover' system property
 */
export function isCoverProperty(uuid: string): boolean {
  return uuid === SYSTEM_PROPERTY_UUIDS.cover;
}

/**
 * Block-only classes - cannot be assigned to pages
 */
export const BLOCK_ONLY_CLASS_UUIDS = [
  SYSTEM_CLASS_UUIDS.query,
  SYSTEM_CLASS_UUIDS.comment,
  SYSTEM_CLASS_UUIDS.quote,
  SYSTEM_CLASS_UUIDS.warning,
  SYSTEM_CLASS_UUIDS.note,
  SYSTEM_CLASS_UUIDS.tip,
  SYSTEM_CLASS_UUIDS.info,
  SYSTEM_CLASS_UUIDS.danger,
  SYSTEM_CLASS_UUIDS.success,
  SYSTEM_CLASS_UUIDS.cloze,
] as const;

/**
 * Check if a class UUID is block-only (cannot be assigned to pages)
 */
export function isBlockOnlyClass(uuid: string): boolean {
  return BLOCK_ONLY_CLASS_UUIDS.includes(uuid as typeof BLOCK_ONLY_CLASS_UUIDS[number]);
}

/**
 * Check if a property is the 'Banner' system property
 */
export function isBannerProperty(uuid: string): boolean {
  return uuid === SYSTEM_PROPERTY_UUIDS.banner;
}

/**
 * Check if a node UUID is a system class UUID
 * These classes are managed by the system and should not be user-removable
 */
export function isSystemClassUuid(uuid: string | null | undefined): boolean {
  if (!uuid) return false;
  return Object.values(SYSTEM_CLASS_UUIDS).includes(uuid as typeof SYSTEM_CLASS_UUIDS[keyof typeof SYSTEM_CLASS_UUIDS]);
}

/**
 * Non-removable system classes - cannot be removed from nodes
 * These are fundamental to the node's identity or system-managed
 */
export const NON_REMOVABLE_CLASS_UUIDS = [
  SYSTEM_CLASS_UUIDS.page,
  SYSTEM_CLASS_UUIDS.class,
  SYSTEM_CLASS_UUIDS.day,
  SYSTEM_CLASS_UUIDS.month,
  SYSTEM_CLASS_UUIDS.year,
] as const;

/**
 * Check if a class UUID is non-removable (cannot be removed from nodes)
 */
export function isNonRemovableClass(uuid: string | null | undefined): boolean {
  if (!uuid) return false;
  return NON_REMOVABLE_CLASS_UUIDS.includes(uuid as typeof NON_REMOVABLE_CLASS_UUIDS[number]);
}
