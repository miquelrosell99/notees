/**
 * System Pages Utility
 * 
 * Identifies system-generated pages that should not have editable names:
 * - Daily notes (date format pages)
 * - Monthly notes
 * - Yearly notes
 * - Default pages created by the system
 */
import type { Node } from '@/types';

/**
 * Default system page names that should not be editable
 */
export const DEFAULT_SYSTEM_PAGES = [
  'Home',
  'Inbox',
  'Archive',
  'Trash',
  'Templates',
  'Favorites',
  'Quick Notes',
];

/**
 * Check if a page is a date-related page (daily, monthly, yearly)
 */
export function isDatePage(node: Node): boolean {
  // Check the is_daily flag
  if (node.is_daily) return true;
  
  // Check UUID format for date pages
  // Date UUIDs: YYYYMMDD (day), YYYYMM00 (month), YYYY0000 (year)
  const uuid = node.uuid;
  if (uuid && /^\d{8}$/.test(uuid)) {
    const year = parseInt(uuid.substring(0, 4), 10);
    if (year >= 1900 && year <= 2200) {
      return true;
    }
  }
  
  // Check name patterns for date pages
  const name = node.name || '';
  
  // Daily note: matches "January 1, 2024" or "2024-01-01" or similar patterns
  const dailyPatterns = [
    /^\d{4}-\d{2}-\d{2}$/,  // 2024-01-01
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}$/i,
    /^\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i,
  ];
  
  for (const pattern of dailyPatterns) {
    if (pattern.test(name)) return true;
  }
  
  // Monthly note: matches "January 2024" or "2024-01"
  const monthlyPatterns = [
    /^\d{4}-\d{2}$/,  // 2024-01
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i,
  ];
  
  for (const pattern of monthlyPatterns) {
    if (pattern.test(name)) return true;
  }
  
  // Yearly note: matches "2024"
  if (/^\d{4}$/.test(name)) {
    const year = parseInt(name, 10);
    if (year >= 1900 && year <= 2200) return true;
  }
  
  return false;
}

/**
 * Check if a page is a default system page
 */
export function isDefaultSystemPage(node: Node): boolean {
  const name = node.name?.trim() || '';
  return DEFAULT_SYSTEM_PAGES.some(
    sysName => sysName.toLowerCase() === name.toLowerCase()
  );
}

/**
 * Check if a page is a system page (date or default)
 * System pages have non-editable names
 */
export function isSystemPage(node: Node): boolean {
  return isDatePage(node) || isDefaultSystemPage(node);
}

/**
 * Check if a page name can be edited
 */
export function canEditPageName(node: Node): boolean {
  return !isSystemPage(node);
}
