/**
 * WorkspaceClientMigrations — the client-side content-migration runner
 * (F3). The keyed-side remedy the server-side refusal names: a "content"-
 * class migration plans against the local UNSEALED derived store and
 * commits through the client's normal write path — `buildEnvelope` stamps
 * the session's actor/device/HLC and the single enqueue seam applies
 * locally + enters the outbox, so the sync engine seals and pushes the ops
 * on a keyed workspace exactly like any write. NO new crypto, NO wire
 * change. Standalone domain — takes the shared ClientContext, like the
 * reads/writes domains.
 */

import { payloadSchemaFor } from "@notees/protocol";

import type { ClientContext } from "./client-context.js";
import type { Store } from "../../../../../vendor/notees/packages/store/src/index.ts";
import {
  findMigration,
  MIGRATIONS,
  type MigrationDefinition,
  type MigrationPlanReport,
} from "../migrations/registry.js";

export class WorkspaceClientMigrations {
  constructor(private readonly ctx: ClientContext) {}

  /**
   * The migrations needing a run on THIS workspace: every registered core
   * whose `isPending` probe fires against the local store. Reports cross
   * the WorkerClient RPC — plain-serializable throughout.
   */
  listPendingMigrations(): MigrationPlanReport[] {
    const reports: MigrationPlanReport[] = [];
    for (const definition of MIGRATIONS) {
      if (!definition.isPending(this.storeForCores())) continue;
      reports.push(this.report(definition.id));
    }
    return reports;
  }

  /**
   * The dry-run report for one migration — the planner's counts + the
   * conflict rows, ZERO writes (the surface shows this before the confirm).
   */
  planMigration(id: string): MigrationPlanReport {
    return this.report(id);
  }

  /**
   * Run one migration: a FRESH plan against the current store, the op
   * triples payload-validated (the core's protocol gate equivalent — a
   * payload that fails the wire schema never reaches the log), then ONE
   * undo-journal batch through the single enqueue seam ("Undo migration"
   * restores the whole gesture). Returns the committed run's report.
   */
  runMigration(id: string): MigrationPlanReport {
    const definition = findMigration(id);
    const plan = definition.plan(this.storeForCores());
    const ops = definition.buildOps(plan);
    for (const op of ops) {
      const schema = payloadSchemaFor(op.opType);
      if (schema === undefined || !schema.safeParse(op.payload).success) {
        throw new Error(`migration ${id}: ${op.opType} payload fails protocol validation`);
      }
    }
    this.ctx.undoJournal.batch(() => {
      for (const op of ops) {
        this.ctx.enqueueLocal(this.ctx.buildEnvelope(op.opType, op.payload, op.affected));
      }
    }, "migration");
    return this.reportFor(definition, plan);
  }

  private report(id: string): MigrationPlanReport {
    const definition = findMigration(id);
    return this.reportFor(definition, definition.plan(this.storeForCores()));
  }

  /**
   * The dev-condition dual identity, bridged once: `ctx.store` types against
   * the vendored packages' dist (tsc's `@notees/*` mapping) while the cores
   * type against src — the same class, one program-view boundary. Under
   * vitest both sides already resolve to src, so the cast is a no-op there.
   */
  private storeForCores(): Store {
    return this.ctx.store as unknown as Store;
  }

  private reportFor(
    definition: MigrationDefinition<unknown>,
    plan: unknown,
  ): MigrationPlanReport {
    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      ...definition.toReport(plan),
    };
  }
}
