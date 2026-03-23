/**
 * Navigation History Store — tracks browser history position for back/forward buttons.
 *
 * Works alongside the browser's History API. Each pushUrl() call increments
 * the internal index and stores it in the pushState state object. On popstate,
 * the index is read back to determine canGoBack / canGoForward.
 */
import { create } from 'zustand';

interface NavigationHistoryState {
  currentIndex: number;
  maxIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;

  /** Called when a new URL is pushed (not replace). */
  push: () => number;
  /** Called on popstate — reads the stored index from history.state. */
  handlePopState: (index: number) => void;
  /** Navigate back. */
  goBack: () => void;
  /** Navigate forward. */
  goForward: () => void;
}

export const useNavigationHistoryStore = create<NavigationHistoryState>()(
  (set, get) => ({
    currentIndex: 0,
    maxIndex: 0,
    canGoBack: false,
    canGoForward: false,

    push: () => {
      const newIndex = get().currentIndex + 1;
      set({
        currentIndex: newIndex,
        maxIndex: newIndex,
        canGoBack: newIndex > 0,
        canGoForward: false,
      });
      return newIndex;
    },

    handlePopState: (index: number) => {
      const { maxIndex } = get();
      set({
        currentIndex: index,
        canGoBack: index > 0,
        canGoForward: index < maxIndex,
      });
    },

    goBack: () => {
      if (get().canGoBack) {
        window.history.back();
      }
    },

    goForward: () => {
      if (get().canGoForward) {
        window.history.forward();
      }
    },
  }),
);
