import { useNavigationStore } from '@/stores';

/**
 * Returns true when the app is in focus mode.
 *
 * Use this to set data-focus-mode on component roots so each component can
 * own its own focus-mode styling instead of relying on global CSS reach.
 */
export function useFocusMode(): boolean {
  return useNavigationStore((state) => state.viewMode === 'focus');
}
