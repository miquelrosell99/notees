/**
 * useSectionData — the shared lazy-section data contract. ONE
 * hook instance per section
 * view (the per-view rule, owner pass 2): a section's default view and
 * each custom view each own their instance — never
 * one shared cache with view-switch invalidation, which would re-run queries
 * a switch should be silent on.
 *
 * The contract the hook owns (the timing; the strategy owns the what):
 *  - resolution runs on FIRST ACTIVATION only — `active: false` (a collapsed
 *    section) executes NO query;
 *  - results cache across deactivations: a reactivation at an unchanged
 *    notification version serves the cache — a collapse/expand never
 *    re-runs;
 *  - a client notification re-runs the resolution while active (a collapsed
 *    section stays silent — its cached rows serve the next expand until the
 *    version moves);
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
 * stacks: a page variant declares an ordered list of descriptors; the
 * hook owns WHEN resolution runs, the strategy owns WHAT it reads. The
 * transient filter layer ships as part of this contract (`filterable`);
 * the hosted custom views remain the follow-up.
 *
 * The transient filter layer (components/filterQuery.ts): a `filter`
 * applies a FilterQuery's composed query-AST group to the resolved rows
 * POST-RESOLUTION and PRE-WINDOWING — the returned rows are the filtered
 * set, so the collection's windowing sees filtered rows; the resolution
 * cache is untouched (a query change re-derives from the cached rows, it
 * never re-runs the query). The eager count stays UNFILTERED: `total` is
 * the resolved count before the filter, and an active filter renders "0 of N"
 * rather than hiding the section.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { Group } from "@notees/query";

import type { ClientNode } from "@/core/workspace-client.js";

import type { AnyClient, NodeCollectionItem, NodeCollectionProps, ViewMode } from "../views/index.js";
import {
  createSectionViewMatcher,
  planSectionView,
  resolveSectionViewProbed,
  type SectionViewPlan,
} from "../views/sectionViewResolve.js";
import type { FilterBarConfig } from "./filterQuery.js";

/** The resolution context handed to every strategy. */
export interface SectionCtx {
  client: AnyClient;
}

/**
 * The transient filter a section applies to its resolved rows: the composed
 * query-AST root group plus the row→node accessor the conditions read (a
 * backlinks row's node is its source; a collection row's node is the item's
 * node).
 */
export interface SectionRowFilter<Row> {
  group: Group;
  nodeOf: (row: Row) => ClientNode;
}

export interface UseSectionDataOptions<T> {
  client: AnyClient;
  /**
   * This view's activation: false = collapsed — no first
   * resolution runs. Default true (resolve from mount — views whose eager
   * count IS the resolution, like CreatedSection).
   */
  active?: boolean;
  /**
   * Values the strategy closes over that can change WITHOUT a client
   * notification (device prefs like the unlinked-ignore list): changing it
   * post-activation re-runs the resolution at an unchanged version. Compare
   * by identity — pass a joined/primitive value, not a fresh object.
   */
  refreshKey?: unknown;
  /**
   * The transient filter layer (list-shaped row sets only): applied
   * post-resolution, pre-windowing. The query changes re-derive from the
   * cached rows on the next render — it is never part of the resolution
   * signature, so a filter change re-runs no query.
   */
  filter?: (T extends readonly (infer Row)[] ? SectionRowFilter<Row> : never) | undefined;
  /** Cheap synchronous client/derived read strategy. */
  read?: ((ctx: SectionCtx) => T) | undefined;
  /** Structured-query strategy (self-bounding: range ASTs, row caps). */
  query?: ((ctx: SectionCtx) => Promise<T>) | undefined;
}

export interface SectionData<T> {
  /**
   * The resolved rows; null until the first activation's resolution
   * completes (or fails — a first failure keeps null, so the view renders
   * its not-yet-loaded state honestly). With an active filter this is the
   * FILTERED set — windowing downstream sees filtered rows.
   */
  rows: T | null;
  /**
   * The resolved row count BEFORE the transient filter — the eager-count
   * law: chrome reads this for the unfiltered count (an active filter
   * shows "0 of N", never hides the section). Null until the first
   * resolution completes.
   */
  total: number | null;
}

export function useSectionData<T>({
  client,
  active = true,
  refreshKey,
  filter,
  read,
  query,
}: UseSectionDataOptions<T>): SectionData<T> {
  const [rows, setRows] = useState<T | null>(null);
  /** The {version, refreshKey} signature the last run consumed; null = never ran. */
  const lastSig = useRef<{ version: number; key: unknown } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  useEffect(() => {
    if (!active) return;
    const sig = lastSig.current;
    if (sig !== null && sig.version === version && sig.key === refreshKey) {
      return; // cached result is still fresh — a reactivation is silent on it
    }
    lastSig.current = { version, key: refreshKey };
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
  }, [client, active, version, refreshKey, read, query]);

  // The transient filter step: post-resolution, pre-windowing. The query
  // plans through the one evaluation implementation (a schema-invalid group
  // plans to null — rows stay unfiltered, chrome never fails).
  //
  // Two evaluation arms, both sectionViewResolve's: the SYNC arm
  // (createSectionViewMatcher over one EvalContext) covers every base-column
  // condition; the PROBE arm covers the joined-metadata leaves (linkedTo,
  // content fts) — one membership query per leaf through runQueryAst,
  // intersected with the base rows, mirrored from useSectionViewResolution
  // (the one-evaluation ruling: no second evaluator). The probe lands in an
  // effect keyed on the AST + row-id signature + notify version; until the
  // first result lands the rows stay unfiltered, after that the LAST landed
  // set applies (a stale beat while typing, never a flash of everything).
  const filterPlan = useMemo<SectionViewPlan | null>(() => {
    if (filter === undefined) return null;
    try {
      return planSectionView({
        version: 1,
        scope: { type: "entire_workspace" },
        root: filter.group,
      });
    } catch {
      return null;
    }
  }, [filter]);

  const needsProbe = filterPlan !== null && filterPlan.needsProbe;
  const probeRows = useMemo(
    () =>
      needsProbe && Array.isArray(rows) && filter !== undefined
        ? (rows as unknown[]).map((row) => ({
            node: (filter as SectionRowFilter<unknown>).nodeOf(row),
          }))
        : [],
    [needsProbe, rows, filter],
  );
  const probeSignature = needsProbe
    ? `${JSON.stringify(filterPlan!.ast)}|${probeRows.map((item) => item.node.id).join(",")}|${version}`
    : "";
  const [probedIds, setProbedIds] = useState<{
    key: string;
    ids: ReadonlySet<string>;
  } | null>(null);

  useEffect(() => {
    if (!needsProbe || filterPlan === null || probeSignature === "") return;
    let cancelled = false;
    resolveSectionViewProbed(client, { items: probeRows, groups: undefined }, filterPlan)
      .then((result) => {
        if (!cancelled) {
          setProbedIds({
            key: probeSignature,
            ids: new Set(result.items.map((item) => item.node.id)),
          });
        }
      })
      .catch(() => {
        // A failed probe keeps the last filtered set — never empties the
        // section, never throws through render.
      });
    return () => {
      cancelled = true;
    };
    // The signature carries the AST + rows + version identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, needsProbe, probeSignature]);

  const matcher = useMemo(
    () =>
      filter !== undefined && filterPlan !== null && !filterPlan.needsProbe
        ? createSectionViewMatcher(client, filterPlan)
        : null,
    [filter, filterPlan, client],
  );

  const filtered =
    rows === null || filter === undefined || !Array.isArray(rows)
      ? rows
      : matcher !== null
        ? (rows as unknown[]).filter((row) =>
            matcher((filter as SectionRowFilter<unknown>).nodeOf(row)),
          )
        : probedIds === null
          ? rows // first probe still running — the unfiltered set stands
          : (rows as unknown[]).filter((row) =>
              probedIds.ids.has((filter as SectionRowFilter<unknown>).nodeOf(row).id),
            );
  return { rows: filtered as T | null, total: Array.isArray(rows) ? rows.length : null };
}

/**
 * SectionSpec — the data-facing section descriptor:
 * a section stack is DATA, not JSX branches. A page variant declares an
 * ordered list of these; each entry is consumed by one useSectionData
 * instance riding one skin (CollectionSection). Nothing consumes the
 * descriptor yet beyond this file — the first slice ships the hook and the
 * skin; the section stacks land slice by slice (the class/date variants).
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
  /**
   * The transient filter layer (default OFF): true renders the FilterBar
   * with its full facet set, a FilterBarConfig names the offered facets,
   * absent/false renders no bar. The bar's state is transient component
   * state — one instance per section view, nothing persisted.
   */
  filterable?: boolean | FilterBarConfig;
  /** Optional view-mode switcher set within a view. */
  viewModes?: ViewMode[];
  /** Extra NodeCollection props (groups / renderItem / readOnly / trailingAction / windowed …). */
  props?: Partial<Omit<NodeCollectionProps, "client" | "items" | "viewMode">>;
  /** The variant gate (day/class …) — false removes the section from the stack. */
  when?: (ctx: SectionCtx) => boolean;
}
