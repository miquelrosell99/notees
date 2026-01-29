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
  extends: '00000000-0000-0000-0000-000000000008',
} as const;

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
} as const;

/**
 * Check if a property UUID is a system property
 */
export function isSystemPropertyUuid(uuid: string): boolean {
  return Object.values(SYSTEM_PROPERTY_UUIDS).includes(uuid as typeof SYSTEM_PROPERTY_UUIDS[keyof typeof SYSTEM_PROPERTY_UUIDS]);
}

/**
 * Check if a property is the 'tags' system property
 */
export function isTagsProperty(uuid: string): boolean {
  return uuid === SYSTEM_PROPERTY_UUIDS.tags;
}

/**
 * Check if a property is the 'cover' system property
 */
export function isCoverProperty(uuid: string): boolean {
  return uuid === SYSTEM_PROPERTY_UUIDS.cover;
}

/**
 * Check if a property is the 'banner' system property
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
