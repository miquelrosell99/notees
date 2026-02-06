/**
 * Date Formatting Utilities
 * 
 * Centralized date and time formatting functions used across the application.
 */

/**
 * Format a date string to a localized date format
 * 
 * @param dateStr - ISO date string or undefined
 * @returns Formatted date string (e.g., "Jan 15, 2024") or "Unknown"
 */
export function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return 'Unknown';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  } catch {
    return 'Unknown';
  }
}

/**
 * Format a date string to a relative time string
 * 
 * @param dateStr - ISO date string or undefined
 * @returns Relative time string (e.g., "2h ago", "3d ago") or formatted date for older dates
 */
export function formatRelativeTime(dateStr: string | undefined): string {
  if (!dateStr) return 'Unknown';
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateStr);
  } catch {
    return 'Unknown';
  }
}

/**
 * Format a date string to a simple local date format
 * 
 * @param dateStr - ISO date string
 * @returns Formatted date string or fallback to relative time
 */
export function formatSimpleDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString();
  } catch {
    return formatRelativeTime(dateStr);
  }
}
