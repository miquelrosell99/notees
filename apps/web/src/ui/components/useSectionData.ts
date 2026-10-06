/**
 * useSectionData — the shared lazy-section data contract (the S2 machinery:
 * .plans/2026-10-06-1352-main-content-restructure/06-main-content-restructure.md
 * §"Diagram 5 — the section data contract"). ONE hook instance per section
 * view/tab (the per-view rule, owner pass 2): a section's default view, each
 * backlinks tab, and (later) each custom tab each own their instance — never
 * one shared cache with view-switch invalidation, which would re-run queries
 * a switch should be silent on.
 *
 * The contract the hook owns (the timing; the strategy owns the what):
 *  - resolution runs on FIRST ACTIVATION only — `active: false` (a collapsed
 *    section, an unselected tab) executes NO query;
 *  - results cache across deactivations: a reactivation at an unchanged
 *    notification version serves the cache — a tab switch never re-runs;
 *  - a client notification re-runs the resolution while active (and, with
 *    `keepFresh`, also while inactive — the backlinks-tab contract: a loaded
 *    tab stays fresh for its next selection);
 *  - a failure (closed client, failed query) keeps the previous rows — a
 *    section is reference material, never a boot gate.
 *
 * Resolution strategies (exactly one): `read` — a cheap synchronous
 * client/derived read; `query` — a structured query (the QueryAST channel),
 * self-bounding the way today's sections do (range ASTs, row caps). The
 * windowing contract is untouched: resolved rows feed NodeCollection and
 * useWindowed stays the sole windowing authority.
 *
 * `SectionSpec` (below) is the data-facing descriptor for the future section
 * stacks (S5+): a page variant declares an ordered list of descriptors; the
 * hook owns WHEN resolution runs, the strategy owns WHAT it reads. The
 * transient filter layer (M3) and the hosted custom views (M4) are recorded
 * in the plan but deliberately NOT part of this descriptor yet.
 */

import { useEffect, useRef, useState } from "react";

import type { AnyClient, NodeCollectionItem, NodeCollectionProps, ViewMode } from "../views/index.js";

/** The resolution context handed to every strategy. */
export interface SectionCtx {
  client: AnyClient;
}

export interface UseSectionDataOptions<T> {
  client: AnyClient;
  /**
   * This view's activation: false = collapsed/unselected — no first
   * resolution runs. Default true (resolve from mount — views whose eager
   * count IS the resolution, like CreatedSection).
   */
  active?: boolean;
  /**
   * After the first activation, re-run per client notification even while
   * INACTIVE (the backlinks-tab contract: every loaded tab re-derives on a
   * notification, so selecting it lands on fresh rows). Default false — the
   * collapsible-section contract re-runs only while expanded.
   */
  keepFresh?: boolean;
  /**
   * Values the strategy closes over that can change WITHOUT a client
   * notification (device prefs like the unlinked-ignore list): changing it
   * post-activation re-runs the resolution at an unchanged version. Compare
   * by identity — pass a joined/primitive value, not a fresh object.
   */
  refreshKey?: unknown;
  /** Cheap synchronous client/derived read strategy. */
  read?: ((ctx: SectionCtx) => T) | undefined;
  /** Structured-query strategy (self-bounding: range ASTs, row caps). */
  query?: ((ctx: SectionCtx) => Promise<T>) | undefined;
}

export interface SectionData<T> {
  /**
   * The resolved rows; null until the first activation's resolution
   * completes (or fails — a first failure keeps null, so the view renders
   * its not-yet-loaded state honestly).
   */
  rows: T | null;
}

export function useSectionData<T>({
  client,
  active = true,
  keepFresh = false,
  refreshKey,
  read,
  query,
}: UseSectionDataOptions<T>): SectionData<T> {
  const [rows, setRows] = useState<T | null>(null);
  /** The {version, refreshKey} signature the last run consumed; null = never ran. */
  const lastSig = useRef<{ version: number; key: unknown } | null>(null);
  /** First activation has happened (the keepFresh gate). */
  const activated = useRef(false);
  const [version, setVersion] = useState(0);

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  useEffect(() => {
    if (!active && !(keepFresh && activated.current)) return;
    const sig = lastSig.current;
    if (sig !== null && sig.version === version && sig.key === refreshKey) {
      return; // cached result is still fresh — a switch is silent on it
    }
    lastSig.current = { version, key: refreshKey };
    activated.current = true;
    let cancelled = false;
    const run = async () => {
      try {
        const next = read !== undefined ? read({ client }) : await query!({ client });
        if (!cancelled) setRows(next);
      } catch {
        // Closed client or a failed resolution: keep the previous rows.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, active, keepFresh, version, refreshKey, read, query]);

  return { rows };
}

/**
 * SectionSpec — the data-facing section descriptor (the sketch in §Diagram 5):
 * a section stack is DATA, not JSX branches. A page variant declares an
 * ordered list of these; each entry is consumed by one useSectionData
 * instance riding one skin (CollectionSection). Nothing consumes the
 * descriptor yet beyond this file — the S2 slice ships the hook and the skin;
 * the section stacks land slice by slice (S5 class/date variants).
 */
export interface SectionSpec {
  key: string;
  title: string;
  icon?: string;
  /** Eager count read — the hide-when-empty gate (a stored number, exempt from the lazy contract). */
  count?: (ctx: SectionCtx) => number;
  /** Exactly one resolution strategy (what the rows are). */
  read?: (ctx: SectionCtx) => NodeCollectionItem[];
  query?: (ctx: SectionCtx) => Promise<NodeCollectionItem[]>;
  /** Optional view-mode switcher set within a view. */
  viewModes?: ViewMode[];
  /** Extra NodeCollection props (groups / renderItem / readOnly / trailingAction / windowed …). */
  props?: Partial<Omit<NodeCollectionProps, "client" | "items" | "viewMode">>;
  /** The variant gate (day/class …) — false removes the section from the stack. */
  when?: (ctx: SectionCtx) => boolean;
}
