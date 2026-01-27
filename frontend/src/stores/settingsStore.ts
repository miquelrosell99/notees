/**
 * Settings store using Zustand
 * 
 * Manages user preferences with localStorage persistence.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemePreference = 'light' | 'dark' | 'system';

export type DateFormat = 
  | 'YYYY/MM/DD'
  | 'YYYY-MM-DD'
  | 'DD/MM/YYYY'
  | 'DD-MM-YYYY'
  | 'MM/DD/YYYY'
  | 'MM-DD-YYYY';

export interface DateFormatOption {
  value: DateFormat;
  label: string;
  example: string;
}

export const DATE_FORMAT_OPTIONS: DateFormatOption[] = [
  { value: 'YYYY/MM/DD', label: 'YYYY/MM/DD', example: '2026/01/15' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD', example: '2026-01-15' },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY', example: '15/01/2026' },
  { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY', example: '15-01-2026' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY', example: '01/15/2026' },
  { value: 'MM-DD-YYYY', label: 'MM-DD-YYYY', example: '01-15-2026' },
];

export type QuickAddDestination = 'inbox' | 'today';

interface SettingsState {
  // Theme
  theme: ThemePreference;
  
  // Date format
  dateFormat: DateFormat;
  
  // Other settings
  defaultView: 'journal' | 'all-pages' | 'graph' | 'today';
  showDailyNotes: boolean;
  fontSize: 'small' | 'medium' | 'large';
  quickAddDestination: QuickAddDestination;
  
  // Actions
  setTheme: (theme: ThemePreference) => void;
  setDateFormat: (format: DateFormat) => void;
  setDefaultView: (view: 'journal' | 'all-pages' | 'graph' | 'today') => void;
  setShowDailyNotes: (show: boolean) => void;
  setFontSize: (size: 'small' | 'medium' | 'large') => void;
  setQuickAddDestination: (destination: QuickAddDestination) => void;
}

/**
 * Apply theme to document based on preference
 */
export function applyTheme(theme: ThemePreference): void {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (theme === 'light') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    // System preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
}

/**
 * Format a date according to the given format
 */
export function formatDate(date: Date, format: DateFormat): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  switch (format) {
    case 'YYYY/MM/DD':
      return `${year}/${month}/${day}`;
    case 'YYYY-MM-DD':
      return `${year}-${month}-${day}`;
    case 'DD/MM/YYYY':
      return `${day}/${month}/${year}`;
    case 'DD-MM-YYYY':
      return `${day}-${month}-${year}`;
    case 'MM/DD/YYYY':
      return `${month}/${day}/${year}`;
    case 'MM-DD-YYYY':
      return `${month}-${day}-${year}`;
    default:
      return `${year}/${month}/${day}`;
  }
}

/**
 * Format a month according to the given format
 */
export function formatMonth(year: number, month: number, format: DateFormat): string {
  const monthStr = String(month).padStart(2, '0');
  const separator = format.includes('/') ? '/' : '-';
  
  // Check if format starts with year (YYYY-*)
  if (format.startsWith('YYYY')) {
    // ISO style: YYYY/MM or YYYY-MM
    return `${year}${separator}${monthStr}`;
  } else {
    // European/US style: MM/YYYY or DD/MM/YYYY style
    return `${monthStr}${separator}${year}`;
  }
}

/**
 * Parse a date string from any supported format
 */
export function parseFormattedDate(dateStr: string): { year: number; month: number; day: number } | null {
  // Try to extract numbers
  const parts = dateStr.split(/[-/]/);
  if (parts.length !== 3) return null;
  
  const nums = parts.map(p => parseInt(p, 10));
  if (nums.some(isNaN)) return null;
  
  // Determine format based on which part looks like a year
  if (nums[0] > 31) {
    // YYYY/MM/DD or YYYY-MM-DD
    return { year: nums[0], month: nums[1], day: nums[2] };
  } else if (nums[2] > 31) {
    // DD/MM/YYYY or MM/DD/YYYY
    // Assume DD/MM/YYYY for European, but check if first > 12
    if (nums[0] > 12) {
      return { year: nums[2], month: nums[1], day: nums[0] };
    } else if (nums[1] > 12) {
      return { year: nums[2], month: nums[0], day: nums[1] };
    } else {
      // Ambiguous, assume DD/MM/YYYY
      return { year: nums[2], month: nums[1], day: nums[0] };
    }
  }
  
  return null;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      // Defaults
      theme: 'system',
      dateFormat: 'YYYY/MM/DD',
      defaultView: 'journal',
      showDailyNotes: true,
      fontSize: 'medium',
      quickAddDestination: 'today',
      
      // Actions
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      
      setDateFormat: (dateFormat) => {
        set({ dateFormat });
      },
      
      setDefaultView: (defaultView) => {
        set({ defaultView });
      },
      
      setShowDailyNotes: (showDailyNotes) => {
        set({ showDailyNotes });
      },
      
      setFontSize: (fontSize) => {
        set({ fontSize });
      },
      
      setQuickAddDestination: (quickAddDestination) => {
        set({ quickAddDestination });
      },    }),
    {
      name: 'notees-settings',
      // Initialize theme on rehydration
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.theme);
        }
      },
    }
  )
);

// Listen for system theme changes
if (typeof window !== 'undefined') {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', () => {
    const { theme } = useSettingsStore.getState();
    if (theme === 'system') {
      applyTheme('system');
    }
  });
}
