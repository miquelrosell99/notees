import { useCallback, useState, useSyncExternalStore } from "react";
import { BridgeOfflineError, BridgeShapeError } from "../bridge/client";
import type { BridgeResponse, BridgeResult } from "../bridge/types";

export type SearchFn = (q: string) => Promise<BridgeResponse<{ results: BridgeResult[] }>>;

export type SearchError =
  | { kind: "bridge"; code: string; message: string }
  | { kind: "offline" }
  | { kind: "shape"; message: string };

export type SearchView = {
  state: "idle" | "loading" | "results" | "error";
  query: string;
  results: BridgeResult[];
  error: SearchError | null;
};

/** Injectable debounce clock: schedules `fn` and returns a canceller. */
export type ScheduleFn = (fn: () => void, ms: number) => () => void;

export interface SearchEngineOptions {
  searchFn: SearchFn;
  debounceMs?: number;
  schedule?: ScheduleFn;
}

const DEFAULT_DEBOUNCE_MS = 300;

function toSearchError(e: unknown): SearchError {
  if (e instanceof BridgeOfflineError) return { kind: "offline" };
  if (e instanceof BridgeShapeError) return { kind: "shape", message: e.detail };
  return {
    kind: "bridge",
    code: "unknown",
    message: e instanceof Error ? e.message : String(e),
  };
}

/**
 * Framework-free search state machine: debounced query → loading → results |
 * error. Drives the `useSearch` hook but unit-testable in node with an
 * injected schedule (fake timers) and searchFn — no React renderer needed.
 *
 * Only the newest query is applied: the pending debounce is cancelled on each
 * `setQuery`, and a generation guard drops responses whose query has been
 * superseded.
 */
export class SearchEngine {
  private view: SearchView = { state: "idle", query: "", results: [], error: null };
  private readonly listeners = new Set<() => void>();
  private cancelPending: (() => void) | null = null;
  private generation = 0;

  constructor(private opts: SearchEngineOptions) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getView(): SearchView {
    return this.view;
  }

  get searchFn(): SearchFn {
    return this.opts.searchFn;
  }

  /**
   * Follow a re-paired bridge: swap the searchFn, drop the pending debounce,
   * and bump the generation so an in-flight response from the old bridge is
   * never applied.
   */
  setSearchFn(searchFn: SearchFn): void {
    if (searchFn === this.opts.searchFn) return;
    this.opts.searchFn = searchFn;
    this.cancelPending?.();
    this.cancelPending = null;
    this.generation += 1;
  }

  /**
   * Store the raw query text (no rewriting mid-edit); trim only at the
   * debounce boundary, where the trimmed value is what gets searched.
   */
  setQuery(query: string): void {
    const q = query.trim();
    this.cancelPending?.();
    this.cancelPending = null;
    const generation = ++this.generation;
    if (q === "") {
      this.setView({ state: "idle", query, results: [], error: null });
      return;
    }
    this.setView({ ...this.view, query });
    const schedule = this.opts.schedule ?? defaultSchedule;
    this.cancelPending = schedule(
      () => {
        void this.run(q, query, generation);
      },
      this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    );
  }

  private setView(view: SearchView): void {
    this.view = view;
    for (const listener of this.listeners) listener();
  }

  private async run(query: string, rawQuery: string, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.setView({ state: "loading", query: rawQuery, results: [], error: null });
    try {
      const res = await this.opts.searchFn(query);
      if (generation !== this.generation) return;
      if (!res.ok) {
        // The Task 2 client synthesizes { code: "shape" } when the wire
        // payload is malformed — that is a bridge-shape error, distinct from
        // a server-side failure such as not_found.
        const error: SearchError =
          res.error.code === "shape"
            ? { kind: "shape", message: res.error.message }
            : { kind: "bridge", code: res.error.code, message: res.error.message };
        this.setView({ state: "error", query: rawQuery, results: [], error });
        return;
      }
      this.setView({ state: "results", query: rawQuery, results: res.results, error: null });
    } catch (e) {
      if (generation !== this.generation) return;
      this.setView({ state: "error", query: rawQuery, results: [], error: toSearchError(e) });
    }
  }
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => {
    clearTimeout(id);
  };
}

export interface UseSearchOptions {
  debounceMs?: number;
}

/** Debounced search over an injected searchFn (typically `bridge.search`). */
export function useSearch(searchFn: SearchFn, options?: UseSearchOptions) {
  const [engine] = useState(
    () => new SearchEngine({ searchFn, debounceMs: options?.debounceMs }),
  );
  // Follow a re-paired bridge: useConnection installs a new bridge object and
  // the panel re-renders with a new searchFn — the engine must search the new
  // one, not close over the bridge from first render.
  if (engine.searchFn !== searchFn) engine.setSearchFn(searchFn);
  const view = useSyncExternalStore(engine.subscribe, () => engine.getView());
  const setQuery = useCallback((q: string) => engine.setQuery(q), [engine]);
  return { ...view, setQuery };
}
