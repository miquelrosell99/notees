/**
 * useWindowed — the §34.70 pagination convention's engine: a session-local
 * display window over a list that can grow unbounded. The window is a
 * DISPLAY concern only — the input list stays whole, exports and counts read
 * it directly, and the window never drops data silently: `remaining` names
 * the hidden count and the ShowMoreButton affordance renders it at the end
 * of the list. Sorting/filtering resets the window via `resetKey`.
 */

import { useState } from "react";

/** Rows per window when a surface does not name its own size. */
export const DEFAULT_WINDOW_SIZE = 100;

export interface UseWindowedOptions {
  /** Rows per window; default DEFAULT_WINDOW_SIZE. */
  size?: number | undefined;
  /**
   * Sort/filter identity: when it changes, the window resets to `size`
   * (a resort re-narrows instead of inheriting a grown window).
   */
  resetKey?: string | undefined;
  /**
   * False disables the window entirely — a container that owns its own
   * pagination (query results with their cap + load-more) opts out so the
   * list never double-windows. The window state stays alive (hooks are
   * unconditional) but renders nothing.
   */
  enabled?: boolean | undefined;
}

export interface WindowedState<T> {
  /** The loaded slice — `items.slice(0, end)`, never more than items.length. */
  visible: T[];
  /** Hidden count: items.length − visible.length. The affordance names it. */
  remaining: number;
  /** False when everything is visible (the affordance hides). */
  hasMore: boolean;
  /** Grow the window by `size`; a no-op once everything is visible. */
  showMore: () => void;
}

export function useWindowed<T>(
  items: readonly T[],
  options?: UseWindowedOptions,
): WindowedState<T> {
  const size = options?.size ?? DEFAULT_WINDOW_SIZE;
  const resetKey = options?.resetKey ?? "";
  const enabled = options?.enabled ?? true;
  // Derived-state-from-props (the QueriesHub limitKey precedent): a resetKey
  // change re-initializes during render, so the reset lands in the same
  // commit as the sort/filter that caused it.
  const [state, setState] = useState<{ key: string; end: number }>({
    key: resetKey,
    end: size,
  });
  if (state.key !== resetKey) setState({ key: resetKey, end: size });

  if (!enabled) {
    return {
      visible: [...items],
      remaining: 0,
      hasMore: false,
      showMore: () => {},
    };
  }
  const visible = items.slice(0, state.end);
  const remaining = Math.max(0, items.length - state.end);
  return {
    visible,
    remaining,
    hasMore: remaining > 0,
    showMore: () =>
      setState((current) => ({ ...current, end: current.end + size })),
  };
}
