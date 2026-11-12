/**
 * migrations — the client-side content-migration registry (F3).
 *
 * A "content"-class migration plans against the object graph, so a keyed
 * workspace cannot run it server-side (the sealed prefix is invisible to a
 * server-side plan — the refusal the dev-ops contract names, scripts/lib/
 * scratch-store.ts). The remedy the refusal promises is this: the migration
 * runs INSIDE a keyed client, against the local UNSEALED derived store, and
 * commits through the client's normal write path — the sync engine seals
 * and pushes the ops like any write. No new crypto, no wire change.
 *
 * Each migration's pure planning core lives in the sync repo at
 * `scripts/lib/migrations/<name>.ts` — NODE-DEP-FREE by contract, consumed
 * here through the vendor pin (the same vendor-relative idiom as
 * scripts/lib/map-query-ast-v1-v2.js). This module is the registry the
 * surface lists by and the client domain runs through: registration is
 * per-core (Stage 2 wires only the proving pattern — meeting-date
 * retirement; further cores join by an entry here).
 */

// The Store type rides the vendor pin's SRC import, exactly like the cores
// (tsc reads the vendored packages' dist through the `@notees/*` mapping
// while the cores type against src — the dev-condition dual identity of the
// SAME class; the registry lives on the src side so the core functions
// assign without casts, and the one boundary (ctx.store) bridges in
// client-migrations).
import type { Store } from "../../../../../packages/store/src/index.ts";

import {
  buildRetirementOps,
  isPending as retirementIsPending,
  planMeetingDateRetirement,
  type RetirementPlan,
} from "../../../../../scripts/lib/migrations/meeting-date-retirement.ts";

/**
 * One migration write in its wire-neutral triple form — the shape the
 * client stamps with its session constants through `buildEnvelope` + the
 * single enqueue seam (the core's op builder output, verbatim).
 */
export interface MigrationOpTriple {
  opType: string;
  payload: Record<string, unknown>;
  affected: string[];
}

/**
 * The UI-facing report: counts + the conflict rows (values that stay put,
 * never silently dropped). Everything plain-serializable — the reports
 * cross the WorkerClient RPC boundary.
 */
export interface MigrationPlanReport {
  id: string;
  title: string;
  description: string;
  /** The op count a run would commit. */
  opCount: number;
  /** Count lines: [["copies", 3], ["removals", 3], …]. */
  counts: Array<[string, number]>;
  conflicts: Array<{ nodeId: string; reason: string }>;
}

/**
 * The registry entry contract: the pending probe, the planner, the op
 * builder, and the plan→report projection — all against a `Store`, all
 * node-free through the core.
 */
export interface MigrationDefinition<Plan> {
  id: string;
  title: string;
  /** The dry-run/row copy: what the migration converges and what stays put. */
  description: string;
  isPending(store: Store): boolean;
  plan(store: Store): Plan;
  buildOps(plan: Plan): MigrationOpTriple[];
  toReport(plan: Plan): Omit<MigrationPlanReport, "id" | "title" | "description">;
}

/** The proving pattern: meeting-date retirement (the sync repo's core). */
const meetingDateRetirement: MigrationDefinition<RetirementPlan> = {
  id: "meeting-date-retirement",
  title: "Meeting-date retirement",
  description:
    "Copies each meeting's withdrawn Meeting date onto its inherited Event date, removes the " +
    "leftover Meeting date values and declarations, unbinds the property from the meeting class, " +
    "and soft-deletes the withdrawn schema. Nodes whose Event date already carries a value keep " +
    "their Meeting date for manual review — reported, never silently dropped.",
  isPending: retirementIsPending,
  plan: planMeetingDateRetirement,
  buildOps: buildRetirementOps,
  toReport: (plan) => ({
    opCount: buildRetirementOps(plan).length,
    counts: [
      ["values copied to Event date", plan.copies.length],
      ["Meeting date values removed", plan.removals.length],
      ["declarations removed", plan.unassigns.length],
      ["class bindings unset", plan.bindingUnset ? 1 : 0],
      ["schemas retired", plan.schemaDelete ? 1 : 0],
    ],
    conflicts: plan.conflicts.map((conflict) => ({
      nodeId: conflict.nodeId,
      reason: conflict.reason,
    })),
  }),
};

export const MIGRATIONS: ReadonlyArray<MigrationDefinition<unknown>> = [meetingDateRetirement];

export function findMigration(id: string): MigrationDefinition<unknown> {
  const definition = MIGRATIONS.find((entry) => entry.id === id);
  if (definition === undefined) throw new Error(`unknown migration: ${id}`);
  return definition;
}
