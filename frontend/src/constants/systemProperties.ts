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
  _query_ast: '00000000-0000-0000-0000-000000000007',  // Hidden system property for query nodes
  _whiteboard_data: '00000000-0000-0000-0000-000000000010',  // Whiteboard layout JSON
  // Task class properties
  task_status: '00000000-0000-0000-0003-000000000001',
  task_deadline: '00000000-0000-0000-0003-000000000002',
  task_scheduled: '00000000-0000-0000-0003-000000000003',
  task_priority: '00000000-0000-0000-0003-000000000004',
  task_closed_date: '00000000-0000-0000-0003-000000000005',
  task_recurrence: '00000000-0000-0000-0003-000000000006',
  // Source hierarchy & attachments
  attachments: '00000000-0000-0000-0000-000000000011',
  authors: '00000000-0000-0000-0000-000000000012',
  isbn: '00000000-0000-0000-0000-000000000013',
  doi: '00000000-0000-0000-0000-000000000014',
  publication_date: '00000000-0000-0000-0000-000000000015',
  publisher: '00000000-0000-0000-0000-000000000016',
  role: '00000000-0000-0000-0000-000000000017',
  // "locator" (…0018) withdrawn — highlights carry position info as text; do not reuse
  provenance: '00000000-0000-0000-0000-000000000019',
  highlight_asset: '00000000-0000-0000-0000-000000000020',
  given_name: '00000000-0000-0000-0000-000000000021',
  family_name: '00000000-0000-0000-0000-000000000022',
  citekey: '00000000-0000-0000-0000-000000000023',
  url: '00000000-0000-0000-0000-000000000024',
} as const;

/**
 * System class icons - mirrors the backend SYSTEM_CLASS_ICONS in
 * app/domain/entities/constants.py (guarded by the system-UUID parity test).
 */
export const SYSTEM_CLASS_ICONS: Record<string, string> = {
  class: 'mdiTagMultiple',
  day: 'mdiCalendarToday',
  month: 'mdiCalendarMonth',
  year: 'mdiCalendarText',
  quote: 'mdiFormatQuoteClose',
  query: 'mdiMagnify',
  asset: 'mdiPaperclip',
  whiteboard: 'mdiDraw',
  card: 'mdiCardOutline',
  template: 'mdiFileDocumentOutline',
  task: 'mdiCheckboxMarkedCircleOutline',
  comment: 'mdiCommentOutline',
  table: 'mdiTable',
  warning: 'mdiAlert',
  note: 'mdiNoteOutline',
  tip: 'mdiLightbulbOutline',
  info: 'mdiInformationOutline',
  danger: 'mdiAlertCircle',
  success: 'mdiCheckCircle',
  cloze: 'mdiEyeOff',
  source: 'mdiBookshelf',
  book: 'mdiBookOpenVariant',
  paper: 'mdiNewspaperVariantOutline',
  article: 'mdiNewspaper',
  thesis: 'mdiSchoolOutline',
  document: 'mdiFileOutline',
  agent: 'mdiAccountGroupOutline',
  person: 'mdiAccountOutline',
  organization: 'mdiDomain',
  collection: 'mdiFolderMultipleOutline',
  highlight: 'mdiFormatHighlight',
  weblink: 'mdiLinkVariant',
  movie: 'mdiMovieOpenOutline',
};

/**
 * Canonical extends edges between system classes (class name -> parent class
 * names). Mirrors the backend SYSTEM_CLASS_EXTENDS (parity-test guarded).
 */
export const SYSTEM_CLASS_EXTENDS: Record<string, string[]> = {
  book: ['source'],
  paper: ['source'],
  article: ['source'],
  thesis: ['source'],
  document: ['source'],
  movie: ['source'],
  person: ['agent'],
  organization: ['agent'],
};

/** Class-scoped system property schema specification (see SYSTEM_PROPERTY_SCHEMA_SPECS). */
export interface SystemPropertySchemaSpec {
  type: string;
  multi?: boolean;
  classFilter?: string[];
  options?: Array<{ uuid: string; name: string; sequence: number }>;
  defaultValue?: string;
  bindTo: string;
}

/**
 * Class-scoped system property schemas, in canonical seed order. Keys are
 * property names (also keys of SYSTEM_PROPERTY_UUIDS); `bindTo` names the
 * system class the schema is bound to via a classPropertyEdge. Mirrors the
 * backend SYSTEM_PROPERTY_SCHEMA_SPECS (parity-test guarded).
 */
export const SYSTEM_PROPERTY_SCHEMA_SPECS: Record<string, SystemPropertySchemaSpec> = {
  attachments: { type: 'node', multi: true, classFilter: ['asset'], bindTo: 'source' },
  authors: { type: 'node', multi: true, classFilter: ['agent'], bindTo: 'source' },
  isbn: { type: 'text', bindTo: 'source' },
  doi: { type: 'text', bindTo: 'source' },
  publication_date: { type: 'date', bindTo: 'source' },
  publisher: { type: 'text', bindTo: 'source' },
  role: {
    type: 'selection',
    options: [
      { uuid: '00000000-0000-0000-0004-000000000001', name: 'representation', sequence: 0 },
      { uuid: '00000000-0000-0000-0004-000000000002', name: 'cover', sequence: 1 },
      { uuid: '00000000-0000-0000-0004-000000000003', name: 'supplement', sequence: 2 },
      { uuid: '00000000-0000-0000-0004-000000000004', name: 'attachment', sequence: 3 },
      { uuid: '00000000-0000-0000-0004-000000000005', name: 'generated', sequence: 4 },
      { uuid: '00000000-0000-0000-0004-000000000006', name: 'thumbnail', sequence: 5 },
      { uuid: '00000000-0000-0000-0004-000000000007', name: 'other', sequence: 6 },
    ],
    bindTo: 'asset',
  },
  provenance: { type: 'text', bindTo: 'highlight' },
  highlight_asset: { type: 'node', classFilter: ['asset'], bindTo: 'highlight' },
  given_name: { type: 'text', bindTo: 'person' },
  family_name: { type: 'text', bindTo: 'person' },
  citekey: { type: 'text', defaultValue: '', bindTo: 'source' },
  url: { type: 'url', bindTo: 'weblink' },
};

/** Extra class-property binding for a base system property (see SYSTEM_EXTRA_CLASS_BINDINGS). */
interface ExtraClassBinding {
  bindTo: string;
  sequence: number;
}

/**
 * Extra class-property bindings for base system properties whose schemas are
 * created outside SYSTEM_PROPERTY_SCHEMA_SPECS (e.g. the global cover
 * property): seeds emit only the classPropertyEdge, never the schema.
 * `sequence` is the next free per-class slot (source's spec-bound schemas
 * occupy 0-6). Mirrors the backend SYSTEM_EXTRA_CLASS_BINDINGS (parity-test
 * guarded).
 */
export const SYSTEM_EXTRA_CLASS_BINDINGS: Record<string, ExtraClassBinding> = {
  cover: { bindTo: 'source', sequence: 7 },
};

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
  source: '00000000-0000-0000-0001-000000000023',
  book: '00000000-0000-0000-0001-000000000024',
  paper: '00000000-0000-0000-0001-000000000025',
  article: '00000000-0000-0000-0001-000000000026',
  thesis: '00000000-0000-0000-0001-000000000027',
  document: '00000000-0000-0000-0001-000000000028',
  agent: '00000000-0000-0000-0001-000000000029',
  person: '00000000-0000-0000-0001-000000000030',
  organization: '00000000-0000-0000-0001-000000000031',
  collection: '00000000-0000-0000-0001-000000000032',
  highlight: '00000000-0000-0000-0001-000000000033',
  weblink: '00000000-0000-0000-0001-000000000034',
  movie: '00000000-0000-0000-0001-000000000035',
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
